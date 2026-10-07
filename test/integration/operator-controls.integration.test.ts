/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- contract JSON fixtures and HTTP bodies are untyped by nature */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import type { PdfRendererPort } from "../../src/application/quote-v2/document/pdf-renderer-port";
import { issuedSnapshotHash } from "../../src/application/quote-v2/issued-snapshot";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { NativePdfRenderer } from "../../src/infrastructure/documents/native-pdf-renderer";
import { repairDocumentArtifact, type DocumentRepairInput } from "../../src/infrastructure/operator/document-repair";
import { listFailedIssuances, type FailedIssuanceFilter } from "../../src/infrastructure/operator/failed-issuances";
import { retryFailedIssuance, type IssuanceRetryInput } from "../../src/infrastructure/operator/issuance-retry";
import { withOperatorDatabase } from "../../src/infrastructure/operator/operator-plane";
import { PostgresIssuanceOperationRepository } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { loadIssuedSnapshot } from "../../src/infrastructure/persistence/postgres/issued-snapshot-loader";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { CommitOutcomeUnknownError, PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS, testRegistryJson } from "../helpers/test-principals";
import { migrateToV1Head, seedV1Snapshot, V1_IDS, V1_PDF_BYTES } from "../helpers/v1-fixture";

/*
 * R1.6C operator controls on real PostgreSQL, the real renderer and the real
 * content-addressed store: issuance:failed, issuance:retry (T10 through the
 * existing primitive) and documents:repair (hash-exact restoration only).
 * Services are driven in-process; the CLI shells are spawned for exit codes
 * and output hygiene.
 *
 * Fixtures that the state machine cannot reach through the API (a moved
 * deadline, a tampered snapshot, an old manifest version) are written with
 * `session_replication_role = replica` on the superuser connection (triggers
 * off for that statement). Production code never does this.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 180_000;
const HOUR_MS = 3_600_000;
const LEASE_MS = 60_000;
const PII = ["Camila", "Rojas", "camila.rojas@example.com", "1234 5678", "Mancuerna", "Banco plano", "conv-7f3a91c2"];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 60_000);

const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");
const operators = PrincipalRegistry.load({ kind: "inline", json: testRegistryJson() });
const renderer = new NativePdfRenderer();

function expectNoPii(output: unknown, extra: readonly string[] = []): void {
  const text = typeof output === "string" ? output : JSON.stringify(output);

  for (const value of [...PII, ...extra]) {
    expect(text).not.toContain(value);
  }
}

async function start(options: { databaseUrl?: string } = {}) {
  let databaseUrl = options.databaseUrl;

  if (!databaseUrl) {
    const testDatabase = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => testDatabase.dispose());
    await runMigrations({ databaseUrl: testDatabase.connectionString, direction: "up" });
    databaseUrl = testDatabase.connectionString;
  }

  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-operator-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const env = buildRuntimeTestEnv({
    databaseUrl,
    storageRoot,
    overrides: {
      QUOTE_ISSUANCE_DEADLINE_MS: String(HOUR_MS),
      QUOTE_ISSUANCE_LEASE_MS: String(LEASE_MS),
      QUOTE_ISSUANCE_POLL_INTERVAL_MS: "500",
      QUOTE_ISSUANCE_SYNC_BUDGET_MS: "10000"
    }
  });
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query<AnyRecord>(text, values)).rows;
  const database = new PostgresDatabase(env);
  cleanups.push(() => database.close());
  const repository = new PostgresIssuanceOperationRepository(database, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
  const store = new FilesystemContentAddressedArtifactStore(storageRoot);

  async function listen(context: ApplicationContext) {
    cleanups.push(async () => {
      await context.shutdown("test-cleanup");
    });
    const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
    await waitFor(() => context.dependencyMonitor.isReady(), 15_000);

    return async (method: string, pathname: string, token: string, body?: unknown, key: string | null = crypto.randomUUID()) => {
      const headers: Record<string, string> = { Authorization: bearer(token) };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (key !== null) {
        headers["Idempotency-Key"] = key;
      }

      const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const json = response.headers.get("content-type")?.startsWith("application/json") ? (JSON.parse(bytes.toString("utf8")) as AnyRecord) : null;
      return { status: response.status, body: json as AnyRecord, bytes };
    };
  }

  // Acceptance only: operations stay where the test puts them.
  const call = await listen(buildApplication(env, { disableIssuanceExecution: true, logStream: { write: () => undefined } }));

  const harness = {
    env,
    sql,
    call,
    database,
    repository,
    store,
    storageRoot,
    databaseUrl,

    /** T4 (creator: sales-integration): `issuing`, pending operation. */
    async createAndIssue(): Promise<{ quoteId: string; operationId: string; quoteNumber: string }> {
      const response = await call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
      expect(response.status).toBe(202);
      return { quoteId: response.body.quote.quoteId, operationId: response.body.operation.operationId, quoteNumber: response.body.quote.quoteNumber };
    },
    /** T1 + T3 (creator: backoffice, who may cancel): `issuing` version 2, pending operation. */
    async draftIssue(): Promise<{ quoteId: string; operationId: string; quoteNumber: string }> {
      const draft = await call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, example("draft-create.request.json"));
      expect(draft.status).toBe(201);
      const issued = await call("POST", `/v2/quotes/${draft.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 });
      expect(issued.status).toBe(202);
      return { quoteId: draft.body.quoteId, operationId: issued.body.operation.operationId, quoteNumber: issued.body.quote.quoteNumber };
    },
    cancel: (quoteId: string, expectedVersion: number) =>
      call("POST", `/v2/quotes/${quoteId}/cancel`, TEST_TOKENS.backoffice, { expectedVersion, reasonCode: "customer_declined" }),

    /** Writes with triggers disabled (fixtures the API cannot produce). */
    async travel(text: string, values: unknown[] = []): Promise<void> {
      await admin.query("begin");

      try {
        await admin.query("set local session_replication_role = replica");
        await admin.query(text, values);
        await admin.query("commit");
      } catch (error) {
        await admin.query("rollback");
        throw error;
      }
    },
    /** T6: the deadline sweep fails the pending operation. */
    async failByDeadline(operationId: string): Promise<void> {
      await harness.travel(
        `update quote_service.issuance_operations
         set deadline_at = date_trunc('milliseconds', clock_timestamp()) - interval '1 second',
             accepted_at = least(accepted_at, date_trunc('milliseconds', clock_timestamp()) - interval '2 hours')
         where operation_id = $1`,
        [operationId]
      );
      const failed = await repository.failDeadlineExceeded(10);
      expect(failed.map((failure) => failure.operationId)).toContain(operationId);
    },
    /** T12: a non-retryable attempt failure (amendment A5). */
    async failNonRetryable(operationId: string): Promise<void> {
      const claimed = await repository.claimOperation(operationId, "worker-t12");
      expect(claimed.kind).toBe("CLAIMED");
      const attempt = (claimed as { attempt: { operationId: string; generation: number; leaseOwner: string } }).attempt;
      expect(
        await repository.failAttempt(
          { operationId: attempt.operationId, generation: attempt.generation, leaseOwner: attempt.leaseOwner },
          { errorCode: "document_generation_failed", retryable: false, reason: "unsupported_glyph" }
        )
      ).toEqual({ kind: "FAILED_NON_RETRYABLE" });
    },
    /** Runs the real issuance worker (real renderer and store) until the quote is issued, then stops it. */
    async issueWithWorker(quoteId: string): Promise<void> {
      const context = buildApplication(env, { logStream: { write: () => undefined } });
      await listen(context);
      await waitFor(async () => (await harness.quote(quoteId)).status === "issued", 60_000, 200);
      await context.shutdown("test-worker-done");
    },
    /** An issued quote with its formal PDF, through the real inline issuance path. */
    async issued(): Promise<{ quoteId: string; manifest: AnyRecord; file: string; bytes: Buffer }> {
      const { quoteId } = await harness.createAndIssue();
      await harness.issueWithWorker(quoteId);
      const manifest = await harness.manifest(quoteId);
      const file = path.join(storageRoot, ...String(manifest.storage_key).split("/"));
      return { quoteId, manifest, file, bytes: fs.readFileSync(file) };
    },

    op: async (operationId: string): Promise<AnyRecord> =>
      (await sql(`select *, generation::text as generation from quote_service.issuance_operations where operation_id = $1`, [operationId]))[0]!,
    quote: async (quoteId: string): Promise<AnyRecord> => (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!,
    manifest: async (quoteId: string): Promise<AnyRecord> =>
      (await sql(`select *, byte_length::int as byte_length from quote_service.quote_documents where quote_id = $1`, [quoteId]))[0]!,
    events: (quoteId: string, type?: string) =>
      sql(
        `select event_type, principal_id, operation_id, correlation_id, idempotency_key_hash, from_status, to_status, data
         from quote_service.quote_audit_events where quote_id = $1 ${type ? "and event_type = $2" : ""} order by sequence`,
        type ? [quoteId, type] : [quoteId]
      ),
    /** Everything except the operation pointer, version and updated_at: the frozen commercial snapshot and identity. */
    async frozen(quoteId: string): Promise<AnyRecord> {
      const quote = { ...(await harness.quote(quoteId)) };
      delete quote.current_operation_id;
      delete quote.version;
      delete quote.updated_at;
      const snapshotHash = await database.withTransaction(async (client) => issuedSnapshotHash(await loadIssuedSnapshot(client, quoteId)));
      return {
        quote,
        snapshotHash,
        lines: await sql(`select * from quote_service.quote_lines where quote_id = $1 order by position`, [quoteId]),
        shipping: await sql(`select * from quote_service.quote_shipping where quote_id = $1`, [quoteId])
      };
    },
    /** Every durable row an operator command could touch. */
    async tables(): Promise<AnyRecord> {
      return {
        quotes: await sql(`select * from quote_service.quotes order by quote_id`),
        operations: await sql(`select *, generation::text as generation from quote_service.issuance_operations order by operation_id`),
        documents: await sql(`select * from quote_service.quote_documents order by document_id`),
        audit: await sql(`select * from quote_service.quote_audit_events order by quote_id, sequence`),
        deliveries: await sql(`select count(*)::int as n from quote_service.quote_deliveries`)
      };
    },

    retry: (input: Partial<IssuanceRetryInput> & Pick<IssuanceRetryInput, "quoteId" | "failedOperationId">, retryRepository = repository) =>
      retryFailedIssuance(
        { database, repository: retryRepository, operators },
        { operatorPrincipalId: "backoffice", reasonCode: "renderer_fixed", confirm: true, ...input }
      ),
    list: (filter: FailedIssuanceFilter = {}) => listFailedIssuances(database, filter),
    repair: (input: Partial<DocumentRepairInput> & Pick<DocumentRepairInput, "quoteId">, repairRenderer: PdfRendererPort = renderer) =>
      repairDocumentArtifact({ database, store, renderer: repairRenderer, operators }, { operatorPrincipalId: "backoffice", confirm: true, ...input }),

    /** Spawns an operator CLI from source (tsx), with the runtime environment of this test. */
    cli(script: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string; json: AnyRecord | null }> {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(process.execPath, ["--import", "tsx", `src/scripts/${script}.ts`, ...args], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: databaseUrl,
            QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson(),
            QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
            ...extraEnv
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("exit", (code) => {
          const text = stdout.trim() || stderr.trim();
          let json: AnyRecord | null;

          try {
            json = JSON.parse(text) as AnyRecord;
          } catch {
            json = null;
          }

          resolve({ code, stdout, stderr, json });
        });
      });
    },

    /** Holds the quote row lock, starts each request once the previous one is queued on a lock, then releases. */
    async raceOnQuoteLock<T>(quoteId: string, requests: Array<() => Promise<T>>): Promise<T[]> {
      const locker = new pg.Client({ connectionString: databaseUrl });
      await locker.connect();
      const waiting = async () =>
        (await sql(`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0]!
          .waiting as number;

      try {
        await locker.query("begin");
        await locker.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [quoteId]);
        const pending: Array<Promise<T>> = [];

        for (const request of requests) {
          pending.push(request());
          const queued = pending.length;
          await waitFor(async () => (await waiting()) >= queued);
        }

        await locker.query("commit");
        return await Promise.all(pending);
      } finally {
        await locker.end();
      }
    }
  };

  return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

/** A renderer that differs from the real one only where the test says. */
const rendererWith = (overrides: Partial<PdfRendererPort>): PdfRendererPort => ({
  rendererVersion: renderer.rendererVersion,
  probe: () => renderer.probe(),
  renderPdf: (model) => renderer.renderPdf(model),
  ...overrides
});

/** A database whose COMMIT result is lost: either it committed or it rolled back, and the caller cannot tell. */
function ambiguous(database: PostgresDatabase, mode: "committed" | "rolled_back"): Pick<PostgresDatabase, "withTransaction" | "query"> {
  const lost = () => new CommitOutcomeUnknownError(new Error("connection terminated during COMMIT"));

  return {
    query: database.query.bind(database),
    async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
      if (mode === "committed") {
        await database.withTransaction(work);
        throw lost();
      }

      const marker = new Error("forced rollback");
      await database
        .withTransaction(async (client) => {
          await work(client);
          throw marker;
        })
        .catch((error: unknown) => {
          if (error !== marker) {
            throw error;
          }
        });
      throw lost();
    }
  };
}

const operationIds = (result: { body: AnyRecord }): string[] => (result.body.items as AnyRecord[]).map((item) => item.operationId as string);

describe("issuance:failed", () => {
  it(
    "A–H: lists exactly the quotes whose CURRENT operation is failed (T6 and T12), with filters and no PII",
    async () => {
      const harness = await start();

      // D: an issued quote (operation succeeded) is never listed.
      const issued = await harness.createAndIssue();
      await harness.issueWithWorker(issued.quoteId);

      const deadline = await harness.draftIssue();
      await harness.failByDeadline(deadline.operationId);
      const nonRetryable = await harness.createAndIssue();
      await harness.failNonRetryable(nonRetryable.operationId);
      // B / C: pending and running are not failures.
      const pending = await harness.createAndIssue();
      const running = await harness.createAndIssue();
      expect((await harness.repository.claimOperation(running.operationId, "worker-c")).kind).toBe("CLAIMED");
      // F: failed, then cancelled by its creator (T11): not eligible.
      const cancelled = await harness.draftIssue();
      await harness.failByDeadline(cancelled.operationId);
      expect((await harness.cancel(cancelled.quoteId, 2)).status).toBe(200);
      // E: failed, then retried: the historical failure is no longer current.
      const retried = await harness.draftIssue();
      await harness.failByDeadline(retried.operationId);
      const retry = await harness.retry({ quoteId: retried.quoteId, failedOperationId: retried.operationId });
      expect(retry.exitCode).toBe(0);

      const all = await harness.list();
      expect(all.exitCode).toBe(0);
      expect(operationIds(all).sort()).toEqual([deadline.operationId, nonRetryable.operationId].sort());
      expect(all.body).toMatchObject({ status: "ok", count: 2, limit: 100, truncated: false });
      const t6 = (all.body.items as AnyRecord[]).find((item) => item.operationId === deadline.operationId)!;
      const t6Row = await harness.op(deadline.operationId);
      expect(t6).toEqual({
        quoteId: deadline.quoteId,
        quoteNumber: deadline.quoteNumber,
        version: 2,
        operationId: deadline.operationId,
        origin: "acceptance",
        retryOfOperationId: null,
        lastErrorCode: "issuance_deadline_exceeded",
        attemptCount: 0,
        acceptedAt: t6Row.accepted_at.toISOString(),
        completedAt: t6Row.completed_at.toISOString(),
        deadlineAt: t6Row.deadline_at.toISOString(),
        snapshotHash: t6Row.snapshot_hash
      });
      expect((all.body.items as AnyRecord[]).find((item) => item.operationId === nonRetryable.operationId)).toMatchObject({
        lastErrorCode: "document_generation_failed",
        attemptCount: 1
      });

      // E: when the retry operation itself fails, it is listed with its lineage.
      const retryOperationId = retry.body.newOperationId as string;
      await harness.failByDeadline(retryOperationId);
      const withRetry = await harness.list({ quoteId: retried.quoteId });
      expect(withRetry.body.items).toEqual([expect.objectContaining({ operationId: retryOperationId, origin: "operator_retry", retryOfOperationId: retried.operationId })]);

      // G: filters.
      expect(operationIds(await harness.list({ errorCode: "document_generation_failed" }))).toEqual([nonRetryable.operationId]);
      expect(operationIds(await harness.list({ operationId: deadline.operationId }))).toEqual([deadline.operationId]);
      expect(operationIds(await harness.list({ operationId: retried.operationId }))).toEqual([]);
      expect(operationIds(await harness.list({ quoteId: pending.quoteId }))).toEqual([]);
      const limited = await harness.list({ limit: 1 });
      expect(limited.body).toMatchObject({ count: 1, limit: 1, truncated: true });

      // H + CLI: the shell prints the same listing, JSON, no PII.
      const cli = await harness.cli("list-failed-issuances", ["--error", "issuance_deadline_exceeded"]);
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({ status: "ok", count: 2 });
      expect(operationIds({ body: cli.json! }).sort()).toEqual([deadline.operationId, retryOperationId].sort());
      expectNoPii(cli.stdout);
      expectNoPii(all.body);
      expect(cli.stdout).not.toMatch(/customer|externalCorrelation|recipient|storage|artifacts\//i);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "I/J: an empty result is success; an unknown or incompatible schema fails closed before any query; bad invocations are refused",
    async () => {
      const harness = await start();
      const empty = await harness.cli("list-failed-issuances", []);
      expect(empty.code).toBe(0);
      expect(empty.json).toEqual({ status: "ok", count: 0, limit: 100, truncated: false, items: [] });

      const unknownFlag = await harness.cli("list-failed-issuances", ["--customer", "x"]);
      expect(unknownFlag.code).toBe(2);
      expect(unknownFlag.json).toEqual({ status: "usage_invalid", message: "unknown flag" });

      // Schema absent.
      const bare = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
      cleanups.push(() => bare.dispose());
      const missing = await harness.cli("list-failed-issuances", [], { DATABASE_URL: bare.connectionString });
      expect(missing.code).toBe(2);
      expect(missing.json).toMatchObject({ status: "schema_incompatible", schemaState: "SCHEMA_MISSING", expectedHead: "000009_quote_snapshot_child_insert_guard", actualHead: null });

      // Schema ahead of this build (an unknown 000010).
      await harness.sql(`insert into public.schema_migrations (name, run_on) values ('000010_unknown_future', now())`);
      const ahead = await harness.cli("list-failed-issuances", []);
      expect(ahead.code).toBe(2);
      expect(ahead.json).toMatchObject({ status: "schema_incompatible", schemaState: "SCHEMA_AHEAD_OR_UNKNOWN", actualHead: null });
      expect(`${ahead.stdout}${ahead.stderr}`).not.toContain("000010_unknown_future");
      expect(`${ahead.stdout}${ahead.stderr}`).not.toMatch(/postgres:|password|at .*\.ts/);

      // The gate itself: `work` never runs against an incompatible schema.
      let ran = false;
      const gated = await withOperatorDatabase(harness.env, () => {
        ran = true;
        return Promise.resolve({ exitCode: 0, body: {} });
      });
      expect(gated.exitCode).toBe(2);
      expect(ran).toBe(false);

      // Unreachable database: could not run (1), sanitized.
      const down = await harness.cli("list-failed-issuances", [], { DATABASE_URL: "postgres://user:secret@127.0.0.1:1/none" });
      expect(down.code).toBe(1);
      expect(down.json).toMatchObject({ status: "database_unavailable" });
      expect(`${down.stdout}${down.stderr}`).not.toContain("secret");
    },
    TEST_TIMEOUT_MS
  );
});

describe("issuance:retry (T10 through the existing primitive)", () => {
  it(
    "R/T–AB: a T6-failed operation is retried once, attributed to the operator with its reason code, and the SAME quote is then issued",
    async () => {
      const harness = await start();
      const { quoteId, operationId: failedId, quoteNumber } = await harness.draftIssue();
      await harness.failByDeadline(failedId);
      const frozenBefore = await harness.frozen(quoteId);
      const quoteBefore = await harness.quote(quoteId);
      const failedBefore = await harness.op(failedId);

      const result = await harness.retry({ quoteId, failedOperationId: failedId, reasonCode: "renderer_fixed" });
      expect(result.exitCode).toBe(0);
      const newId = result.body.newOperationId as string;
      const created = await harness.op(newId);
      expect(result.body).toEqual({
        status: "retry_created",
        dryRun: false,
        quoteId,
        quoteNumber,
        failedOperationId: failedId,
        lastErrorCode: "issuance_deadline_exceeded",
        operatorPrincipalId: "backoffice",
        reasonCode: "renderer_fixed",
        newOperationId: newId,
        deadlineAt: created.deadline_at.toISOString()
      });

      // V/W/U: a new pending operator_retry operation for the same snapshot.
      expect(created).toMatchObject({
        quote_id: quoteId,
        origin: "operator_retry",
        retry_of_operation_id: failedId,
        status: "pending",
        attempt_count: 0,
        snapshot_hash: failedBefore.snapshot_hash
      });
      expect(created.deadline_at.getTime() - created.accepted_at.getTime()).toBe(HOUR_MS);
      // X/Y/Z: quote still issuing, current operation moved, version + 1.
      expect(await harness.quote(quoteId)).toEqual({ ...quoteBefore, current_operation_id: newId, version: quoteBefore.version + 1, updated_at: created.accepted_at });
      expect(await harness.op(failedId)).toEqual(failedBefore);
      // Z/AA: exactly one audit event, by the operator, with the reason code.
      expect(await harness.events(quoteId, "quote.issue.accepted")).toHaveLength(2);
      expect((await harness.events(quoteId)).at(-1)).toEqual({
        event_type: "quote.issue.accepted",
        principal_id: "backoffice",
        operation_id: newId,
        correlation_id: null,
        idempotency_key_hash: null,
        from_status: "issuing",
        to_status: "issuing",
        data: { retryOf: failedId, quoteNumber, previousVersion: quoteBefore.version, version: quoteBefore.version + 1, deadlineAt: created.deadline_at.toISOString(), reasonCode: "renderer_fixed" }
      });
      // T/U/AB: no commercial change at all.
      expect(await harness.frozen(quoteId)).toEqual(frozenBefore);

      // The retried quote is issued by the real worker: same number, same snapshot hash, one manifest.
      await harness.issueWithWorker(quoteId);
      const issued = await harness.quote(quoteId);
      expect(issued).toMatchObject({ status: "issued", quote_number: quoteNumber, current_operation_id: newId });
      expect(await harness.manifest(quoteId)).toMatchObject({ operation_id: newId, semantic_snapshot_hash: failedBefore.snapshot_hash });
      expect((await harness.frozen(quoteId)).snapshotHash).toBe(frozenBefore.snapshotHash);
      const document = await harness.call("GET", `/v2/quotes/${quoteId}/document`, TEST_TOKENS.backoffice, undefined, null);
      expect(document.status).toBe(200);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "S: a T12 (non-retryable) failed operation is retried and issued",
    async () => {
      const harness = await start();
      const { quoteId, operationId, quoteNumber } = await harness.createAndIssue();
      await harness.failNonRetryable(operationId);
      expect(await harness.op(operationId)).toMatchObject({ status: "failed", last_error_code: "document_generation_failed" });

      const result = await harness.retry({ quoteId, failedOperationId: operationId, reasonCode: "renderer_fixed" });
      expect(result).toMatchObject({ exitCode: 0, body: { status: "retry_created", lastErrorCode: "document_generation_failed" } });
      await harness.issueWithWorker(quoteId);
      expect(await harness.quote(quoteId)).toMatchObject({ status: "issued", quote_number: quoteNumber, current_operation_id: result.body.newOperationId });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AC–AJ: dry run, pending, running, succeeded, cancelled, stale and repeated retries create nothing; snapshot tampering is refused",
    async () => {
      const harness = await start();
      const issued = await harness.createAndIssue();
      await harness.issueWithWorker(issued.quoteId);
      const pending = await harness.createAndIssue();
      const running = await harness.createAndIssue();
      expect((await harness.repository.claimOperation(running.operationId, "worker-r")).kind).toBe("CLAIMED");
      const cancelled = await harness.draftIssue();
      await harness.failByDeadline(cancelled.operationId);
      expect((await harness.cancel(cancelled.quoteId, 2)).status).toBe(200);
      const failed = await harness.draftIssue();
      await harness.failByDeadline(failed.operationId);
      const tampered = await harness.draftIssue();
      await harness.failByDeadline(tampered.operationId);
      await harness.travel(`update quote_service.quote_lines set item_description = 'Altered after acceptance' where quote_id = $1`, [tampered.quoteId]);
      const before = await harness.tables();

      // AJ: dry run reports the plan and mutates nothing.
      const dryRun = await harness.retry({ quoteId: failed.quoteId, failedOperationId: failed.operationId, confirm: false });
      expect(dryRun).toEqual({
        exitCode: 0,
        body: {
          status: "dry_run",
          dryRun: true,
          action: "operator_retry",
          quoteId: failed.quoteId,
          quoteNumber: failed.quoteNumber,
          failedOperationId: failed.operationId,
          lastErrorCode: "issuance_deadline_exceeded",
          operatorPrincipalId: "backoffice",
          reasonCode: "renderer_fixed",
          version: 2,
          versionAfter: 3
        }
      });

      // AC/AD/AE/AF: not applicable (exit 3), with the state that blocks it.
      expect(await harness.retry({ quoteId: pending.quoteId, failedOperationId: pending.operationId })).toMatchObject({
        exitCode: 3,
        body: { status: "not_applicable", reason: "INVALID_STATE", quoteStatus: "issuing", currentOperationStatus: "pending" }
      });
      expect(await harness.retry({ quoteId: running.quoteId, failedOperationId: running.operationId })).toMatchObject({
        exitCode: 3,
        body: { reason: "INVALID_STATE", currentOperationStatus: "running" }
      });
      expect(await harness.retry({ quoteId: issued.quoteId, failedOperationId: issued.operationId })).toMatchObject({
        exitCode: 3,
        body: { reason: "INVALID_STATE", quoteStatus: "issued", currentOperationStatus: "succeeded" }
      });
      expect(await harness.retry({ quoteId: cancelled.quoteId, failedOperationId: cancelled.operationId })).toMatchObject({
        exitCode: 3,
        body: { reason: "INVALID_STATE", quoteStatus: "cancelled" }
      });
      expect(await harness.retry({ quoteId: crypto.randomUUID(), failedOperationId: failed.operationId })).toMatchObject({
        exitCode: 3,
        body: { reason: "QUOTE_NOT_FOUND" }
      });
      // The failed operation of ANOTHER quote is not this quote's current one.
      expect(await harness.retry({ quoteId: failed.quoteId, failedOperationId: tampered.operationId })).toMatchObject({ exitCode: 3, body: { reason: "INVALID_STATE" } });

      // AH: the frozen snapshot no longer hashes to what was accepted → refused (2), dry run and confirmed.
      for (const confirm of [false, true]) {
        const refused = await harness.retry({ quoteId: tampered.quoteId, failedOperationId: tampered.operationId, confirm });
        expect(refused).toEqual({ exitCode: 2, body: { status: "refused", reason: "SNAPSHOT_INTEGRITY", quoteId: tampered.quoteId, failedOperationId: tampered.operationId } });
        expectNoPii(refused.body, ["Altered after acceptance"]);
      }

      // Operator principal (W6) and reason code: refused before any read.
      for (const operatorPrincipalId of ["ghost-operator", "sales-integration", "monitoring", "system", "legacy-v1", "Back Office"]) {
        expect(await harness.retry({ quoteId: failed.quoteId, failedOperationId: failed.operationId, operatorPrincipalId })).toMatchObject({
          exitCode: 2,
          body: { status: "refused", reason: "OPERATOR_PRINCIPAL_REJECTED" }
        });
      }

      expect(await harness.retry({ quoteId: failed.quoteId, failedOperationId: failed.operationId, reasonCode: "fixed by Camila\n" })).toEqual({
        exitCode: 2,
        body: { status: "refused", reason: "REASON_CODE_INVALID" }
      });
      expect(await harness.tables()).toEqual(before);

      // AI/AG: first run creates the retry; the same failed operation again is not applicable and creates nothing.
      const first = await harness.retry({ quoteId: failed.quoteId, failedOperationId: failed.operationId });
      expect(first.exitCode).toBe(0);
      const afterFirst = await harness.tables();
      const second = await harness.retry({ quoteId: failed.quoteId, failedOperationId: failed.operationId });
      expect(second).toEqual({
        exitCode: 3,
        body: {
          status: "not_applicable",
          reason: "INVALID_STATE",
          quoteId: failed.quoteId,
          failedOperationId: failed.operationId,
          quoteStatus: "issuing",
          currentOperationId: first.body.newOperationId,
          currentOperationStatus: "pending"
        }
      });
      expect(await harness.tables()).toEqual(afterFirst);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "CLI: dry run without --yes, T10 with --yes, then not applicable; free-text reasons and injected ids are refused unechoed",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.draftIssue();
      await harness.failByDeadline(operationId);
      const args = ["--quote", quoteId, "--operation", operationId, "--operator", "backoffice", "--reason", "operator_recovery"];
      const before = await harness.tables();

      const dryRun = await harness.cli("retry-issuance", args);
      expect(dryRun.code).toBe(0);
      expect(dryRun.json).toMatchObject({ status: "dry_run", dryRun: true, quoteId, failedOperationId: operationId });
      expect(await harness.tables()).toEqual(before);

      // BM/BN: refused at the shell, value never echoed, nothing written.
      for (const [flag, value] of [
        ["--reason", "renderer fixed\nINJECTED camila.rojas@example.com"],
        ["--operator", 'backoffice","injected":"INJECTED']
      ] as const) {
        const hostile = [...args];
        hostile[hostile.indexOf(flag) + 1] = value;
        const refused = await harness.cli("retry-issuance", [...hostile, "--yes"]);
        expect(refused.code).toBe(2);
        expect(refused.json).toMatchObject({ status: "usage_invalid" });
        expect(`${refused.stdout}${refused.stderr}`).not.toContain("INJECTED");
        expectNoPii(`${refused.stdout}${refused.stderr}`);
      }

      const service = await harness.cli("retry-issuance", [...args.slice(0, 4), "--operator", "sales-integration", "--reason", "operator_recovery", "--yes"]);
      expect(service.code).toBe(2);
      expect(service.json).toEqual({ status: "refused", reason: "OPERATOR_PRINCIPAL_REJECTED", principalCheck: "not_operator" });
      const missing = await harness.cli("retry-issuance", [...args.slice(0, 6), "--yes"]);
      expect(missing.code).toBe(2);
      expect(missing.json).toEqual({ status: "usage_invalid", message: "--reason is required" });
      expect(await harness.tables()).toEqual(before);

      const applied = await harness.cli("retry-issuance", [...args, "--yes"]);
      expect(applied.code).toBe(0);
      expect(applied.json).toMatchObject({ status: "retry_created", dryRun: false, quoteId, failedOperationId: operationId, reasonCode: "operator_recovery" });
      expect((await harness.quote(quoteId)).current_operation_id).toBe(applied.json!.newOperationId);
      expect((await harness.events(quoteId)).at(-1)).toMatchObject({ principal_id: "backoffice", data: { retryOf: operationId, reasonCode: "operator_recovery" } });

      const again = await harness.cli("retry-issuance", [...args, "--yes"]);
      expect(again.code).toBe(3);
      expect(again.json).toMatchObject({ status: "not_applicable", reason: "INVALID_STATE", currentOperationId: applied.json!.newOperationId });
      expect((await harness.sql(`select count(*)::int as n from quote_service.issuance_operations where quote_id = $1`, [quoteId]))[0]!.n).toBe(2);
      expectNoPii(`${dryRun.stdout}${applied.stdout}${again.stdout}`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AK: eight concurrent confirmed retries of one failed operation create exactly one operation",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.draftIssue();
      await harness.failByDeadline(operationId);

      const results = await Promise.all(Array.from({ length: 8 }, () => harness.retry({ quoteId, failedOperationId: operationId })));

      expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
      expect(results.filter((result) => result.exitCode === 3)).toHaveLength(7);
      expect((await harness.sql(`select count(*)::int as n from quote_service.issuance_operations where quote_id = $1`, [quoteId]))[0]!.n).toBe(2);
      expect(await harness.events(quoteId, "quote.issue.accepted")).toHaveLength(2);
      expect((await harness.quote(quoteId)).version).toBe(3);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AL/AM/AN: retry and creator cancel serialize on the quote row in both orders, without deadlock",
    async () => {
      const harness = await start();

      // AL: retry first: the cancel then sees an operation in progress.
      const first = await harness.draftIssue();
      await harness.failByDeadline(first.operationId);
      const [retryWins, cancelLoses] = (await harness.raceOnQuoteLock<AnyRecord>(first.quoteId, [
        () => harness.retry({ quoteId: first.quoteId, failedOperationId: first.operationId }),
        () => harness.cancel(first.quoteId, 2)
      ])) as [AnyRecord, AnyRecord];
      expect(retryWins).toMatchObject({ exitCode: 0, body: { status: "retry_created" } });
      expect(cancelLoses).toMatchObject({ status: 409, body: { error: { code: "operation_in_progress" } } });
      expect(await harness.quote(first.quoteId)).toMatchObject({ status: "issuing", current_operation_id: retryWins.body.newOperationId, version: 3 });

      // AM: cancel first: the retry then sees a cancelled quote and creates nothing.
      const second = await harness.draftIssue();
      await harness.failByDeadline(second.operationId);
      const [cancelWins, retryLoses] = (await harness.raceOnQuoteLock<AnyRecord>(second.quoteId, [
        () => harness.cancel(second.quoteId, 2),
        () => harness.retry({ quoteId: second.quoteId, failedOperationId: second.operationId })
      ])) as [AnyRecord, AnyRecord];
      expect(cancelWins.status).toBe(200);
      expect(retryLoses).toMatchObject({ exitCode: 3, body: { status: "not_applicable", reason: "INVALID_STATE", quoteStatus: "cancelled" } });
      expect((await harness.sql(`select count(*)::int as n from quote_service.issuance_operations where quote_id = $1`, [second.quoteId]))[0]!.n).toBe(1);
      expect(await harness.quote(second.quoteId)).toMatchObject({ status: "cancelled", current_operation_id: second.operationId });

      // AN: no deadlock was detected on the server.
      expect((await harness.sql(`select deadlocks::int as n from pg_stat_database where datname = current_database()`))[0]!.n).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AO: an unknown COMMIT outcome is reconciled from durable state: never a second retry operation",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.draftIssue();
      await harness.failByDeadline(operationId);
      const config = { leaseMs: LEASE_MS, deadlineMs: HOUR_MS };
      const before = await harness.tables();

      // Rolled back: reported as not applied (1); nothing exists; the quote is still listed as failed.
      const rolledBack = await harness.retry({ quoteId, failedOperationId: operationId }, new PostgresIssuanceOperationRepository(ambiguous(harness.database, "rolled_back"), config));
      expect(rolledBack).toMatchObject({ exitCode: 1, body: { status: "not_applied", quoteId, failedOperationId: operationId } });
      expect(await harness.tables()).toEqual(before);
      expect(operationIds(await harness.list({ quoteId }))).toEqual([operationId]);

      // Committed: reported as created, exactly once.
      const committed = await harness.retry({ quoteId, failedOperationId: operationId }, new PostgresIssuanceOperationRepository(ambiguous(harness.database, "committed"), config));
      expect(committed).toMatchObject({ exitCode: 0, body: { status: "retry_created" } });
      expect((await harness.quote(quoteId)).current_operation_id).toBe(committed.body.newOperationId);
      expect(await harness.retry({ quoteId, failedOperationId: operationId })).toMatchObject({ exitCode: 3 });
      expect((await harness.sql(`select count(*)::int as n from quote_service.issuance_operations where quote_id = $1`, [quoteId]))[0]!.n).toBe(2);
    },
    TEST_TIMEOUT_MS
  );
});

describe("documents:repair", () => {
  it(
    "AP–AV, BI: a missing V2 artifact is restored byte-exactly; dry run publishes nothing; manifest, quote, operations and audit are untouched",
    async () => {
      const harness = await start();
      const { quoteId, manifest, file, bytes } = await harness.issued();
      fs.rmSync(file);
      const before = await harness.tables();

      // BI: dry run renders in memory and reports; nothing is published.
      const dryRun = await harness.repair({ quoteId, confirm: false });
      expect(dryRun).toEqual({
        exitCode: 0,
        body: {
          status: "dry_run",
          dryRun: true,
          outcome: "would_repair",
          integrity: "MISSING",
          reproducible: true,
          event: "document.repair",
          operatorPrincipalId: "backoffice",
          quoteId,
          documentId: manifest.document_id,
          origin: "issuance",
          pdfSha256: manifest.pdf_sha256,
          rendererVersion: manifest.renderer_version,
          templateVersion: manifest.template_version
        }
      });
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(path.join(harness.storageRoot, "artifacts", "tmp"))).toEqual([]);

      // AP–AU.
      const repaired = await harness.repair({ quoteId, documentId: manifest.document_id });
      expect(repaired).toMatchObject({ exitCode: 0, body: { status: "repaired", dryRun: false, previousIntegrity: "MISSING", integrity: "OK", pdfSha256: manifest.pdf_sha256 } });
      const restored = fs.readFileSync(file);
      expect(restored.equals(bytes)).toBe(true);
      expect(sha256(restored)).toBe(manifest.pdf_sha256);
      expect(await harness.tables()).toEqual(before);
      expect(await harness.store.readVerified({ origin: "issuance", storageKey: manifest.storage_key, pdfSha256: manifest.pdf_sha256, byteLength: manifest.byte_length })).toMatchObject({ status: "OK" });

      // AV: the document endpoint serves it again.
      const document = await harness.call("GET", `/v2/quotes/${quoteId}/document`, TEST_TOKENS.sales, undefined, null);
      expect(document.status).toBe(200);
      expect(document.bytes.equals(bytes)).toBe(true);

      // BF: an intact artifact is not re-rendered or rewritten.
      const mtime = fs.statSync(file).mtimeMs;
      const intact = await harness.repair({ quoteId });
      expect(intact).toMatchObject({ exitCode: 0, body: { status: "already_intact", integrity: "OK" } });
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
      expectNoPii(repaired.body);
      expect(JSON.stringify([dryRun.body, repaired.body, intact.body])).not.toMatch(/artifacts\/|quote-operator-|storageKey/);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BG/BH: different bytes at the content address are never overwritten (integrity conflict); after the operator quarantines them, repair succeeds",
    async () => {
      const harness = await start();
      const { quoteId, manifest, file, bytes } = await harness.issued();
      const corrupt = Buffer.from(bytes);
      corrupt.writeUInt8(corrupt.readUInt8(corrupt.length - 10) ^ 1, corrupt.length - 10);
      fs.writeFileSync(file, corrupt);
      const before = await harness.tables();

      const dryRun = await harness.repair({ quoteId, confirm: false });
      expect(dryRun).toMatchObject({ exitCode: 2, body: { status: "dry_run", outcome: "would_conflict", integrity: "HASH_MISMATCH", reproducible: true } });
      const conflict = await harness.repair({ quoteId });
      expect(conflict).toMatchObject({ exitCode: 2, body: { status: "refused", reason: "INTEGRITY_CONFLICT", integrity: "HASH_MISMATCH", reproducible: true } });
      expect(fs.readFileSync(file).equals(corrupt)).toBe(true);

      fs.appendFileSync(file, "x");
      expect(await harness.repair({ quoteId })).toMatchObject({ exitCode: 2, body: { reason: "INTEGRITY_CONFLICT", integrity: "LENGTH_MISMATCH" } });
      expect(fs.readFileSync(file).equals(Buffer.concat([corrupt, Buffer.from("x")]))).toBe(true);
      expect(await harness.tables()).toEqual(before);

      // Operator quarantine (outside the command), then the exact bytes are restored.
      fs.renameSync(file, path.join(harness.storageRoot, "quarantined.pdf"));
      expect(await harness.repair({ quoteId })).toMatchObject({ exitCode: 0, body: { status: "repaired", previousIntegrity: "MISSING" } });
      expect(sha256(fs.readFileSync(file))).toBe(manifest.pdf_sha256);
      expect(await harness.tables()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AW–AZ: renderer/template version, semantic snapshot and candidate hash mismatches are refused and publish nothing",
    async () => {
      const harness = await start();
      const { quoteId, manifest, file } = await harness.issued();
      fs.rmSync(file);
      const refusedWithoutPublishing = async (result: Promise<AnyRecord>, reason: string) => {
        expect(await result).toMatchObject({ exitCode: 2, body: { status: "refused", reason } });
        expect(fs.existsSync(file)).toBe(false);
      };

      // AW: the running renderer is another version (never "compatible").
      await refusedWithoutPublishing(harness.repair({ quoteId }, rendererWith({ rendererVersion: `${renderer.rendererVersion}-next` })), "RENDERER_VERSION_MISMATCH");
      // AZ: same version label, different bytes: the hash is the final authority.
      await refusedWithoutPublishing(
        harness.repair({ quoteId }, rendererWith({ renderPdf: async (model) => Buffer.concat([await renderer.renderPdf(model), Buffer.from("\n")]) })),
        "HASH_MISMATCH"
      );
      await refusedWithoutPublishing(harness.repair({ quoteId, confirm: false }, rendererWith({ renderPdf: () => Promise.resolve(Buffer.from("%PDF-1.4 other")) })), "HASH_MISMATCH");
      // Unavailable renderer.
      await refusedWithoutPublishing(harness.repair({ quoteId }, rendererWith({ probe: () => Promise.resolve({ ok: false, failureCategory: "renderer_unavailable" }) })), "RENDERER_UNAVAILABLE");

      const before = await harness.tables();
      // AW (historical manifest of an older renderer) and AX (older template).
      await harness.travel(`update quote_service.quote_documents set renderer_version = 'quote-pdf-r3+pdfmake-0.2.20' where quote_id = $1`, [quoteId]);
      await refusedWithoutPublishing(harness.repair({ quoteId }), "RENDERER_VERSION_MISMATCH");
      await harness.travel(`update quote_service.quote_documents set renderer_version = $2, template_version = 'quote-pdf-template-v3' where quote_id = $1`, [quoteId, manifest.renderer_version]);
      await refusedWithoutPublishing(harness.repair({ quoteId }), "TEMPLATE_VERSION_MISMATCH");
      await harness.travel(`update quote_service.quote_documents set template_version = $2 where quote_id = $1`, [quoteId, manifest.template_version]);
      expect(await harness.tables()).toEqual(before);

      // AY: the frozen snapshot no longer hashes to the recorded semantic hash.
      await harness.travel(`update quote_service.quotes set customer = jsonb_set(customer, '{displayName}', '"Altered Name"') where quote_id = $1`, [quoteId]);
      const tampered = await harness.repair({ quoteId });
      expect(tampered).toMatchObject({ exitCode: 2, body: { status: "refused", reason: "SNAPSHOT_HASH_MISMATCH" } });
      expect(fs.existsSync(file)).toBe(false);
      expectNoPii(tampered.body, ["Altered Name"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BB–BE: malformed storage key, wrong manifest/quote relationship, unknown and non-operator principals are refused; no document is not applicable",
    async () => {
      const harness = await start();
      const first = await harness.issued();
      const second = await harness.issued();
      fs.rmSync(first.file);
      const pending = await harness.createAndIssue();

      // BC: the document id of another quote's manifest.
      expect(await harness.repair({ quoteId: first.quoteId, documentId: second.manifest.document_id })).toMatchObject({
        exitCode: 2,
        body: { status: "refused", reason: "MANIFEST_QUOTE_MISMATCH" }
      });
      expect(await harness.repair({ quoteId: pending.quoteId, documentId: second.manifest.document_id })).toMatchObject({ exitCode: 2, body: { reason: "MANIFEST_QUOTE_MISMATCH" } });
      expect(await harness.repair({ quoteId: pending.quoteId })).toMatchObject({ exitCode: 3, body: { status: "not_applicable", reason: "NO_DOCUMENT", quoteStatus: "issuing" } });
      expect(await harness.repair({ quoteId: crypto.randomUUID() })).toMatchObject({ exitCode: 3, body: { reason: "QUOTE_NOT_FOUND" } });

      // BD/BE: W6.
      for (const operatorPrincipalId of ["ghost-operator", "sales-integration", "system", "legacy-v1"]) {
        expect(await harness.repair({ quoteId: first.quoteId, operatorPrincipalId })).toMatchObject({ exitCode: 2, body: { reason: "OPERATOR_PRINCIPAL_REJECTED" } });
      }

      expect(fs.existsSync(first.file)).toBe(false);

      // BB: a V2 manifest whose key is not the content address of its hash (the database check is removed to plant it).
      await harness.sql(`alter table quote_service.quote_documents drop constraint quote_documents_content_addressed`);
      const wrongKey = `artifacts/sha256/00/00/${first.manifest.pdf_sha256}.pdf`;
      await harness.travel(`update quote_service.quote_documents set storage_key = $2 where quote_id = $1`, [first.quoteId, wrongKey]);
      expect(await harness.repair({ quoteId: first.quoteId })).toMatchObject({ exitCode: 2, body: { status: "refused", reason: "STORAGE_KEY_INVALID" } });
      expect(fs.existsSync(path.join(harness.storageRoot, ...wrongKey.split("/")))).toBe(false);
      expect(fs.existsSync(first.file)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BA: migrated V1 documents are not repairable (V1 renderer retired) and nothing is written",
    async () => {
      const handle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
      cleanups.push(() => handle.dispose());
      await migrateToV1Head(handle.connectionString);
      await seedV1Snapshot(handle.connectionString);
      await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
      const harness = await start({ databaseUrl: handle.connectionString });
      const legacy = (await harness.manifest(V1_IDS.issued));
      expect(legacy.origin).toBe("legacy_v1");
      const before = await harness.tables();

      for (const confirm of [false, true]) {
        const result = await harness.repair({ quoteId: V1_IDS.issued, confirm });
        expect(result).toMatchObject({ exitCode: 2, body: { status: "refused", reason: "NOT_REPAIRABLE_LEGACY", origin: "legacy_v1", documentId: legacy.document_id } });
        expectNoPii(result.body);
      }

      expect(fs.existsSync(path.join(harness.storageRoot, ...String(legacy.storage_key).split("/")))).toBe(false);
      expect(fs.existsSync(path.join(harness.storageRoot, "artifacts", "sha256"))).toBe(false);
      expect(await harness.tables()).toEqual(before);
      expect(V1_PDF_BYTES[V1_IDS.issued]).toBeDefined();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "CLI: dry run, repair with --yes, then GET /document; output has ids and versions only (no path, no PII)",
    async () => {
      const harness = await start();
      const { quoteId, manifest, file, bytes } = await harness.issued();
      fs.rmSync(file);

      const dryRun = await harness.cli("repair-document-artifact", ["--quote", quoteId, "--operator", "backoffice"]);
      expect(dryRun.code).toBe(0);
      expect(dryRun.json).toMatchObject({ status: "dry_run", outcome: "would_repair", integrity: "MISSING" });
      expect(fs.existsSync(file)).toBe(false);

      const service = await harness.cli("repair-document-artifact", ["--quote", quoteId, "--operator", "sales-integration", "--yes"]);
      expect(service.code).toBe(2);
      expect(service.json).toEqual({ status: "refused", reason: "OPERATOR_PRINCIPAL_REJECTED", principalCheck: "not_operator" });

      const repaired = await harness.cli("repair-document-artifact", ["--quote", quoteId, "--document", manifest.document_id, "--operator", "backoffice", "--yes"]);
      expect(repaired.code).toBe(0);
      expect(repaired.json).toMatchObject({ status: "repaired", event: "document.repair", operatorPrincipalId: "backoffice", quoteId, pdfSha256: manifest.pdf_sha256 });
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect((await harness.call("GET", `/v2/quotes/${quoteId}/document`, TEST_TOKENS.sales, undefined, null)).bytes.equals(bytes)).toBe(true);

      const output = `${dryRun.stdout}${dryRun.stderr}${repaired.stdout}${repaired.stderr}${service.stdout}`;
      expect(output).not.toContain(harness.storageRoot);
      expect(output).not.toContain("artifacts/");
      expect(output).not.toContain("%PDF");
      expectNoPii(output);
    },
    TEST_TIMEOUT_MS
  );
});

describe("security / privacy (hostile snapshot data)", () => {
  it(
    "BJ/BK/BL: no CLI output or error exposes customer, RUT, address, lines, prices, snapshot JSON, PDF bytes, paths or credentials",
    async () => {
      const harness = await start();
      const hostile = {
        legalName: 'HOSTILE-LEGAL "},{"injected":true',
        tradeName: "HOSTILE-TRADE <b>",
        rut: "76123456-0",
        contactName: "HOSTILE-CONTACT O'Brien",
        email: "hostile.pii@example.com",
        address: "HOSTILE-ADDRESS 999 \\n line",
        line: "HOSTILE-LINE ${process.env} `whoami`"
      };
      const body = example("create-and-issue.request.json");
      body.customer = {
        kind: "company",
        legalName: hostile.legalName,
        tradeName: hostile.tradeName,
        rut: hostile.rut,
        contactName: hostile.contactName,
        email: hostile.email,
        address: { lines: [hostile.address], commune: "Providencia", region: "Región Metropolitana", country: "CL" }
      };
      body.lines[0].item.description = hostile.line;
      const create = async (reference: string) => {
        const response = await harness.call("POST", "/v2/quotes", TEST_TOKENS.sales, { ...body, externalCorrelation: { ...body.externalCorrelation, externalReference: reference } });
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        return { quoteId: response.body.quote.quoteId as string, operationId: response.body.operation.operationId as string };
      };
      const outputs: string[] = [];
      const run = async (script: string, args: string[], expectedCode: number) => {
        const result = await harness.cli(script, args);
        outputs.push(`${result.stdout}\n${result.stderr}`);
        expect(result.code, `${script} ${args.join(" ")}: ${result.stdout}${result.stderr}`).toBe(expectedCode);
      };

      // Listing and retry on a hostile failed quote, and on a tampered one.
      const failed = await create("hostile-failed");
      await harness.failByDeadline(failed.operationId);
      const tampered = await create("hostile-tampered");
      await harness.failByDeadline(tampered.operationId);
      await harness.travel(`update quote_service.quote_lines set item_description = 'HOSTILE-TAMPERED' where quote_id = $1`, [tampered.quoteId]);
      await run("list-failed-issuances", [], 0);
      const retryArgs = (quote: { quoteId: string; operationId: string }) => [
        "--quote", quote.quoteId, "--operation", quote.operationId, "--operator", "backoffice", "--reason", "operator_recovery"
      ];
      await run("retry-issuance", retryArgs(tampered), 2);
      await run("retry-issuance", [...retryArgs(tampered), "--yes"], 2);
      await run("retry-issuance", retryArgs(failed), 0);
      await run("retry-issuance", [...retryArgs(failed), "--yes"], 0);
      await run("retry-issuance", [...retryArgs(failed), "--yes"], 3);

      // Repair of the hostile issued quote: dry run, restore, then refusals.
      await harness.issueWithWorker(failed.quoteId);
      const manifest = await harness.manifest(failed.quoteId);
      const file = path.join(harness.storageRoot, ...String(manifest.storage_key).split("/"));
      fs.rmSync(file);
      const repairArgs = ["--quote", failed.quoteId, "--operator", "backoffice"];
      await run("repair-document-artifact", repairArgs, 0);
      await run("repair-document-artifact", [...repairArgs, "--yes"], 0);
      fs.rmSync(file);
      await harness.travel(`update quote_service.quote_documents set template_version = 'quote-pdf-template-v3' where quote_id = $1`, [failed.quoteId]);
      await run("repair-document-artifact", [...repairArgs, "--yes"], 2);
      await harness.travel(`update quote_service.quote_documents set template_version = $2 where quote_id = $1`, [failed.quoteId, manifest.template_version]);
      await harness.travel(`update quote_service.quote_lines set item_description = 'HOSTILE-TAMPERED' where quote_id = $1`, [failed.quoteId]);
      await run("repair-document-artifact", [...repairArgs, "--yes"], 2);
      await run("repair-document-artifact", ["--quote", failed.quoteId, "--operator", 'x","customer":"HOSTILE-INJECTED'], 2);

      const all = outputs.join("\n");
      expectNoPii(all, [
        "HOSTILE",
        hostile.rut,
        hostile.email,
        "Providencia",
        "O'Brien",
        "whoami",
        "24990",
        "24.990",
        "89990",
        "89.990",
        "lineId",
        '"customer"',
        "%PDF",
        harness.storageRoot,
        "artifacts/",
        "postgres:",
        "password"
      ]);
      expect(all).not.toMatch(/\bat .+\.(ts|js):\d+/);
    },
    TEST_TIMEOUT_MS
  );
});

export type { Harness };
