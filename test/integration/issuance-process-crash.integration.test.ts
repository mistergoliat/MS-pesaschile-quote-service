/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { CommitCuttingProxy } from "../helpers/commit-cutting-proxy";
import { waitFor } from "../helpers/runtime-test-env";
import { startServiceProcess, type ServiceProcess, type ServiceProcessOptions } from "../helpers/service-process";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";

/*
 * R1.5B4 §14–§24: the issuance crash matrix with REAL process failure. Every
 * "crash" below is SIGKILL of a separate OS process (test/process/
 * failpoint-server.ts) held at a named checkpoint, so durability can never
 * depend on a finally block, a shutdown hook or an in-process failure write.
 * Recovery is a second, fresh process; leases expire in PostgreSQL (some
 * scenarios wait for the real 10 s lease, the others shorten the wait by
 * expiring the lease row, which is what time would do).
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 180_000;
const LEASE_MS = 10_000;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 60_000);

async function environment() {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());
  await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-crash-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;

  const env = {
    connectionString: database.connectionString,
    storageRoot,
    sql,
    start: (options: Omit<ServiceProcessOptions, "databaseUrl" | "storageRoot"> & { databaseUrl?: string }): Promise<ServiceProcess> =>
      startServiceProcess({ databaseUrl: database.connectionString, storageRoot, leaseMs: LEASE_MS, ...options }, (cleanup) => cleanups.push(cleanup)),
    /** POST /v2/quotes; the promise settles with the response or with the transport error when the server dies. */
    createAndIssue(service: ServiceProcess, key: string): Promise<{ status: number; body: AnyRecord; headers: Headers } | { error: string }> {
      return fetch(`${service.baseUrl}/v2/quotes`, {
        method: "POST",
        headers: { Authorization: bearer(TEST_TOKENS.sales), "Content-Type": "application/json", "Idempotency-Key": key, "X-Correlation-Id": "b4-crash" },
        body: JSON.stringify(example("create-and-issue.request.json"))
      }).then(
        async (response) => ({ status: response.status, body: (await response.json()) as AnyRecord, headers: response.headers }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
      );
    },
    async document(service: ServiceProcess, quoteId: string) {
      const response = await fetch(`${service.baseUrl}/v2/quotes/${quoteId}/document`, { headers: { Authorization: bearer(TEST_TOKENS.sales) } });
      return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    },
    async onlyQuote(): Promise<AnyRecord> {
      const quotes = await sql(`select * from quote_service.quotes`);
      expect(quotes).toHaveLength(1);
      return quotes[0]!;
    },
    async op(operationId: string): Promise<AnyRecord> {
      return (await sql(`select *, generation::int as generation from quote_service.issuance_operations where operation_id = $1`, [operationId]))[0]!;
    },
    manifests: () => sql(`select *, byte_length::int as byte_length from quote_service.quote_documents`),
    counts: async (): Promise<AnyRecord> =>
      (
        await sql(
          `select (select count(*)::int from quote_service.quotes) as quotes,
                  (select count(*)::int from quote_service.issuance_operations) as operations,
                  (select count(*)::int from quote_service.issuance_operations where status = 'succeeded') as succeeded,
                  (select count(*)::int from quote_service.quote_documents) as documents,
                  (select count(*)::int from quote_service.quote_audit_events where event_type = 'quote.issued') as issued_events,
                  (select count(*)::int from quote_service.quote_deliveries) as deliveries`
        )
      )[0]!,
    expireLease: (operationId: string) =>
      sql(`update quote_service.issuance_operations set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = $1`, [operationId]),
    /** Files under the storage root (relative, sorted), without readiness-probe files. */
    files(prefix = ""): string[] {
      const out: string[] = [];
      const walk = (directory: string) => {
        for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            out.push(path.relative(storageRoot, full).split(path.sep).join("/"));
          }
        }
      };
      walk(storageRoot);
      return out.filter((file) => !/^artifacts\/tmp\/probe-/.test(file) && file.startsWith(prefix)).sort();
    },
    bytesAt: (key: string) => fs.readFileSync(path.join(storageRoot, ...key.split("/"))),
    async waitIssued(quoteId: string, timeoutMs = 60_000): Promise<void> {
      await waitFor(async () => (await sql(`select status from quote_service.quotes where quote_id = $1`, [quoteId]))[0]?.status === "issued", timeoutMs, 200);
    }
  };

  return env;
}

type Env = Awaited<ReturnType<typeof environment>>;

/** Exactly one formal issuance: one manifest naming verified bytes, operation succeeded, quote issued, one audit, served byte-exact. */
async function expectIssuedOnce(env: Env, service: ServiceProcess, quoteId: string, operationId: string): Promise<AnyRecord> {
  const manifests = await env.manifests();
  expect(manifests).toHaveLength(1);
  const manifest = manifests[0]!;
  expect(manifest).toMatchObject({ quote_id: quoteId, operation_id: operationId, origin: "issuance" });
  expect(await env.op(operationId)).toMatchObject({ status: "succeeded", lease_owner: null });
  expect((await env.onlyQuote()).status).toBe("issued");
  expect(await env.counts()).toMatchObject({ quotes: 1, operations: 1, succeeded: 1, documents: 1, issued_events: 1, deliveries: 0 });
  const stored = env.bytesAt(manifest.storage_key);
  expect(sha256(stored)).toBe(manifest.pdf_sha256);
  expect(stored.byteLength).toBe(manifest.byte_length);
  const served = await env.document(service, quoteId);
  expect(served.status).toBe(200);
  expect(sha256(served.bytes)).toBe(manifest.pdf_sha256);
  return manifest;
}

describe("R1.5B4 real process kill: crash matrix", () => {
  it(
    "F1 crash after acceptance COMMIT, before any claim → restart issues the same quote, number and operation; no client retry",
    async () => {
      const env = await environment();
      // Poll interval 60 s: the halted process's periodic worker cannot claim before the kill.
      const a = await env.start({ halt: "after_acceptance_commit", syncBudgetMs: 10_000, pollIntervalMs: 60_000 });
      const response = env.createAndIssue(a, "crash-f1");
      await a.waitFor((line) => line.event === "failpoint.reached");
      const quote = await env.onlyQuote();
      const operationId = quote.current_operation_id as string;
      expect(quote).toMatchObject({ status: "issuing", quote_number: "PC-000001" });
      expect(await env.op(operationId)).toMatchObject({ status: "pending", attempt_count: 0, generation: 0 });

      await a.kill();
      expect(await response).toHaveProperty("error");

      const b = await env.start({ syncBudgetMs: 0 });
      await env.waitIssued(quote.quote_id);
      await expectIssuedOnce(env, b, quote.quote_id, operationId);
      expect(await env.onlyQuote()).toMatchObject({ quote_id: quote.quote_id, quote_number: "PC-000001", current_operation_id: operationId });
      expect(await env.op(operationId)).toMatchObject({ attempt_count: 1, generation: 1 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F2 crash after claim → no failure write; the lease expires in PostgreSQL (real 10 s) and another process reclaims as g+1; quote issuing during the gap",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "after_claim", syncBudgetMs: 10_000 });
      const response = env.createAndIssue(a, "crash-f2");
      const reached = await a.waitFor((line) => line.event === "failpoint.reached");
      const operationId = reached.operationId as string;
      const claimed = await env.op(operationId);
      expect(claimed).toMatchObject({ status: "running", generation: 1, attempt_count: 1, last_error_code: null });
      expect(String(claimed.lease_owner)).toContain(`:${a.pid}:`);

      await a.kill();
      expect(await response).toHaveProperty("error");
      const b = await env.start({ syncBudgetMs: 0 });

      // Before expiry nobody may take it: still A's generation, quote issuing, no failure recorded.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const during = await env.op(operationId);
      if (new Date(during.lease_expires_at as string).getTime() > Date.now() + 1_000) {
        expect(during).toMatchObject({ status: "running", generation: 1, lease_owner: claimed.lease_owner, last_error_code: null });
        expect((await env.onlyQuote()).status).toBe("issuing");
      }

      await env.waitIssued((await env.onlyQuote()).quote_id, 60_000);
      const quote = await env.onlyQuote();
      await expectIssuedOnce(env, b, quote.quote_id, operationId);
      expect(await env.op(operationId)).toMatchObject({ generation: 2, attempt_count: 2, last_error_code: null });
      expect(b.events("issuance.reclaimed")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F3/F4 crash after snapshot verification and after render → no manifest, no final file; reclaim issues normally",
    async () => {
      for (const halt of ["after_snapshot_verified", "after_render"]) {
        const env = await environment();
        const a = await env.start({ halt, syncBudgetMs: 10_000 });
        void env.createAndIssue(a, `crash-${halt}`);
        const { operationId } = await a.waitFor((line) => line.event === "failpoint.reached");
        await a.kill();

        expect(await env.manifests(), halt).toEqual([]);
        expect(env.files("artifacts/sha256/"), halt).toEqual([]);
        expect(env.files("artifacts/tmp/"), halt).toEqual([]);
        expect(await env.op(operationId as string), halt).toMatchObject({ status: "running", generation: 1 });

        await env.expireLease(operationId as string);
        const b = await env.start({ syncBudgetMs: 0 });
        const quote = await env.onlyQuote();
        await env.waitIssued(quote.quote_id);
        await expectIssuedOnce(env, b, quote.quote_id, operationId as string);
        await b.kill();
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F5 crash during temp write (temp fsync'd, before link) → temp residue only; reclaim issues; the stale temp is swept later, formal files never",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "before_artifact_link", syncBudgetMs: 10_000 });
      void env.createAndIssue(a, "crash-f5");
      const reached = await a.waitFor((line) => line.event === "failpoint.reached");
      await a.kill();
      const operationId = (await env.onlyQuote()).current_operation_id as string;

      const residue = env.files("artifacts/tmp/");
      expect(residue).toEqual([`artifacts/tmp/${String(reached.detail)}`]);
      expect(residue[0]).toMatch(/^artifacts\/tmp\/[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/);
      expect(env.files("artifacts/sha256/")).toEqual([]);
      expect(await env.manifests()).toEqual([]);

      await env.expireLease(operationId);
      const b = await env.start({ syncBudgetMs: 0 });
      const quote = await env.onlyQuote();
      await env.waitIssued(quote.quote_id);
      const manifest = await expectIssuedOnce(env, b, quote.quote_id, operationId);
      // The crash temp holds the very bytes that were later published (deterministic render).
      expect(sha256(env.bytesAt(residue[0]!))).toBe(manifest.pdf_sha256);
      // Recent residue is kept (1 h age rule): an active publication's temp is never at risk.
      expect(env.files("artifacts/tmp/")).toEqual(residue);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F6 crash after the final CA file exists, before T5 → reclaim re-renders identical bytes, EEXIST, verifies, reuses the file, T5 commits once",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "after_artifact_published", syncBudgetMs: 10_000 });
      void env.createAndIssue(a, "crash-f6");
      const { operationId } = await a.waitFor((line) => line.event === "failpoint.reached");
      await a.kill();

      const [orphan, ...more] = env.files("artifacts/sha256/");
      expect(more).toEqual([]);
      expect(await env.manifests()).toEqual([]);
      const orphanPath = path.join(env.storageRoot, ...orphan!.split("/"));
      const before = fs.statSync(orphanPath);

      await env.expireLease(operationId as string);
      const b = await env.start({ syncBudgetMs: 0 });
      const quote = await env.onlyQuote();
      await env.waitIssued(quote.quote_id);
      const manifest = await expectIssuedOnce(env, b, quote.quote_id, operationId as string);

      expect(manifest.storage_key).toBe(orphan);
      expect(b.events("issuance.artifact_published")).toEqual([expect.objectContaining({ reused: true, generation: 2 })]);
      const after = fs.statSync(orphanPath);
      expect([after.mtimeMs, after.size, after.ino]).toEqual([before.mtimeMs, before.size, before.ino]);
      expect(env.files("artifacts/")).toEqual([orphan]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F7 crash inside the T5 transaction before COMMIT → PostgreSQL rolls back: no manifest, operation not succeeded, quote issuing; reclaim commits once",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "before_t5_commit", syncBudgetMs: 10_000 });
      void env.createAndIssue(a, "crash-f7");
      const { operationId } = await a.waitFor((line) => line.event === "failpoint.reached");
      await a.kill();

      // The server notices the dead connection and rolls the open transaction back.
      await waitFor(async () => (await env.sql(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`))[0]!.n === 0, 15_000);
      expect(await env.manifests()).toEqual([]);
      expect(await env.op(operationId as string)).toMatchObject({ status: "running", generation: 1, completed_at: null });
      expect(await env.onlyQuote()).toMatchObject({ status: "issuing", version: 1 });
      expect(await env.counts()).toMatchObject({ issued_events: 0 });
      const orphan = env.files("artifacts/sha256/");
      expect(orphan).toHaveLength(1);

      await env.expireLease(operationId as string);
      const b = await env.start({ syncBudgetMs: 0 });
      const quote = await env.onlyQuote();
      await env.waitIssued(quote.quote_id);
      const manifest = await expectIssuedOnce(env, b, quote.quote_id, operationId as string);
      expect(manifest.storage_key).toBe(orphan[0]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F8/F9 crash after the T5 COMMIT (before the attempt returns / before the HTTP response) → the retried request returns the same issued quote, number, operation and document; nothing new",
    async () => {
      for (const halt of ["after_t5_commit", "before_issuance_response"]) {
        const env = await environment();
        const a = await env.start({ halt, syncBudgetMs: 10_000 });
        const first = env.createAndIssue(a, "crash-after-commit");
        const { operationId } = await a.waitFor((line) => line.event === "failpoint.reached");
        await a.kill();
        expect(await first, halt).toHaveProperty("error");

        const committed = { quote: await env.onlyQuote(), manifest: (await env.manifests())[0], counts: await env.counts() };
        expect(committed.quote.status, halt).toBe("issued");
        expect(committed.counts, halt).toMatchObject({ quotes: 1, operations: 1, succeeded: 1, documents: 1 });

        const b = await env.start({ syncBudgetMs: 10_000 });
        const retry = await env.createAndIssue(b, "crash-after-commit");
        expect("status" in retry && retry.status, halt).toBe(201);
        const replay = retry as { status: number; body: AnyRecord; headers: Headers };
        expect(replay.headers.get("idempotent-replay"), halt).toBe("true");
        expect(replay.body.quote, halt).toMatchObject({
          quoteId: committed.quote.quote_id,
          quoteNumber: committed.quote.quote_number,
          status: "issued",
          document: { available: true, pdfSha256: committed.manifest!.pdf_sha256 }
        });
        expect(replay.body.operation, halt).toMatchObject({ operationId, status: "succeeded" });
        await expectIssuedOnce(env, b, committed.quote.quote_id, operationId as string);
        expect(await env.op(operationId as string), halt).toMatchObject({ attempt_count: 1, generation: 1 });
        expect(await env.counts(), halt).toEqual(committed.counts);
        await b.kill();
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F10 zombie: A publishes and is suspended (attempt and lease renewals held), its lease expires, B reclaims and commits; A resumes and its T5 is fenced (STALE_FENCE, zero effect)",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "before_t5", suspendRenewals: true, syncBudgetMs: 10_000 });
      void env.createAndIssue(a, "crash-f10");
      const { operationId } = await a.waitFor((line) => line.event === "failpoint.reached");
      expect(await env.op(operationId as string)).toMatchObject({ status: "running", generation: 1 });

      // B is a second live process; it can only claim once A's lease has really expired.
      const b = await env.start({ syncBudgetMs: 0 });
      const quote = await env.onlyQuote();
      await env.waitIssued(quote.quote_id, 60_000);
      const manifest = await expectIssuedOnce(env, b, quote.quote_id, operationId as string);
      expect(await env.op(operationId as string)).toMatchObject({ status: "succeeded", generation: 2 });
      expect(b.events("issuance.reclaimed")).toHaveLength(1);
      const settled = { quote: await env.onlyQuote(), op: await env.op(operationId as string), counts: await env.counts(), files: env.files() };

      a.resume();
      await a.waitFor((line) => line.event === "issuance.stale_fence", 30_000);
      expect(a.events("issuance.stale_fence")[0]).toMatchObject({ operationId, generation: 1, result: "STALE_FENCE" });
      expect(a.events("issuance.succeeded")).toEqual([]);

      expect({ quote: await env.onlyQuote(), op: await env.op(operationId as string), counts: await env.counts(), files: env.files() }).toEqual(settled);
      expect(settled.files.filter((file) => file.startsWith("artifacts/sha256/"))).toEqual([manifest.storage_key]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "wire-level COMMIT cut against a live process (both outcomes): the process survives the dead connection, reconciles from durable state and answers 201 once",
    async () => {
      for (const mode of ["drop_commit", "drop_commit_response"] as const) {
        const env = await environment();
        const target = new URL(env.connectionString);
        const proxy = await CommitCuttingProxy.create(target.hostname, Number(target.port || 5432));
        cleanups.push(() => proxy.dispose());
        const service = await env.start({ syncBudgetMs: 10_000, databaseUrl: proxy.route(env.connectionString) });
        await service.waitFor((line) => line.event === "runtime.ready" || line.event === "dependency.ready" || line.event === "failpoint_server.listening");
        proxy.arm(mode);

        const created = await env.createAndIssue(service, `wire-${mode}`);
        expect(proxy.cuts.map((cut) => cut.mode), mode).toEqual([mode]);
        expect("status" in created && created.status, mode).toBe(201);
        // Alive: no fatal event, still serving.
        expect(service.child.exitCode, mode).toBeNull();
        expect(service.lines().filter((line) => String(line.event).startsWith("runtime.fatal")), mode).toEqual([]);
        expect((await fetch(`${service.baseUrl}/health/live`)).status, mode).toBe(200);
        const quote = await env.onlyQuote();
        await expectIssuedOnce(env, service, quote.quote_id, quote.current_operation_id as string);
        expect(await env.op(quote.current_operation_id as string), mode).toMatchObject({ attempt_count: 1, generation: 1 });
        await service.kill();
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "temp sweep after a crash: stale crash temps are removed on the next start; recent temps, committed and unreferenced content-addressed files are untouched",
    async () => {
      const env = await environment();
      const a = await env.start({ halt: "before_artifact_link", syncBudgetMs: 10_000 });
      void env.createAndIssue(a, "crash-sweep");
      await a.waitFor((line) => line.event === "failpoint.reached");
      await a.kill();
      const [staleTemp] = env.files("artifacts/tmp/");
      expect(staleTemp).toMatch(/^artifacts\/tmp\/[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/);

      // Recover and commit the quote, then plant an unreferenced CA file and a recent temp.
      const operationId = (await env.onlyQuote()).current_operation_id as string;
      await env.expireLease(operationId);
      const b = await env.start({ syncBudgetMs: 0 });
      await env.waitIssued((await env.onlyQuote()).quote_id);
      const committed = (await env.manifests())[0]!.storage_key as string;
      await b.kill();
      const orphan = await new FilesystemContentAddressedArtifactStore(env.storageRoot).publish(Buffer.from("%PDF-1.3\n% unreferenced orphan\n%%EOF\n"));
      const recentTemp = `artifacts/tmp/${"a".repeat(64)}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(path.join(env.storageRoot, ...recentTemp.split("/")), "in flight");
      // Everything but the recent temp is two hours old: age alone never selects a formal file.
      const old = Date.now() / 1000 - 7_200;
      for (const key of [staleTemp!, committed, orphan.storageKey]) {
        fs.utimesSync(path.join(env.storageRoot, ...key.split("/")), old, old);
      }
      const formalBefore = Object.fromEntries([committed, orphan.storageKey].map((key) => [key, sha256(env.bytesAt(key))]));

      // The next process start runs the storage probe, which sweeps stale temps.
      const c = await env.start({ syncBudgetMs: 0 });
      await waitFor(() => !env.files("artifacts/tmp/").includes(staleTemp!), 15_000);

      expect(env.files("artifacts/tmp/")).toEqual([recentTemp]);
      expect(Object.fromEntries([committed, orphan.storageKey].map((key) => [key, sha256(env.bytesAt(key))]))).toEqual(formalBefore);
      expect(env.files("artifacts/sha256/")).toEqual([committed, orphan.storageKey].sort());
      expect((await env.document(c, (await env.onlyQuote()).quote_id)).status).toBe(200);
    },
    TEST_TIMEOUT_MS
  );
});
