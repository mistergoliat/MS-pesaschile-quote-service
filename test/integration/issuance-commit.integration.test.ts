/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import type { ContentAddressedArtifactStore } from "../../src/application/quote-v2/document/artifact-store-port";
import { buildIssuedQuoteDocumentModelV2 } from "../../src/application/quote-v2/document/issued-quote-document-model";
import { DocumentRenderError, type PdfRendererPort } from "../../src/application/quote-v2/document/pdf-renderer-port";
import { createIssuanceAttemptBody } from "../../src/application/quote-v2/issuance-attempt";
import type { ClaimedAttempt, OperationFence } from "../../src/application/quote-v2/issuance-operation";
import { IssuanceWorker } from "../../src/application/quote-v2/issuance-worker";
import { issuedSnapshotHash } from "../../src/application/quote-v2/issued-snapshot";
import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { NativePdfRenderer } from "../../src/infrastructure/documents/native-pdf-renderer";
import { RENDERER_VERSION } from "../../src/infrastructure/documents/renderer-profile";
import { PostgresIssuanceOperationRepository } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { CommitOutcomeUnknownError, PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";

/*
 * R1.5B3: publication, fenced T5 commit, crash windows (B3 scope), the A5
 * non-retryable path and the inline 201/200/202 behaviour, on real
 * PostgreSQL with the real renderer and the real content-addressed store.
 * Time travel uses `session_replication_role = replica` on the superuser
 * admin connection, exactly as the B1 suite.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 120_000;
const LEASE_MS = 60_000;
const HOUR_MS = 3_600_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

interface StartOptions {
  /** Default: execution off, so a test drives workers explicitly. */
  readonly execution?: boolean;
  readonly syncBudgetMs?: number;
  readonly pollIntervalMs?: number;
  readonly databaseUrl?: string;
  readonly storageRoot?: string;
}

async function start(options: StartOptions = {}) {
  const testDatabase = options.databaseUrl ? null : await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  const connectionString = options.databaseUrl ?? testDatabase!.connectionString;

  if (testDatabase) {
    cleanups.push(() => testDatabase.dispose());
    await runMigrations({ databaseUrl: connectionString, direction: "up" });
  }

  const storageRoot = options.storageRoot ?? (await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-issuance-commit-")));

  if (!options.storageRoot) {
    cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  }

  const env = buildRuntimeTestEnv({
    databaseUrl: connectionString,
    storageRoot,
    overrides: {
      QUOTE_ISSUANCE_DEADLINE_MS: String(HOUR_MS),
      QUOTE_ISSUANCE_LEASE_MS: String(LEASE_MS),
      QUOTE_ISSUANCE_POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 500),
      QUOTE_ISSUANCE_SYNC_BUDGET_MS: String(options.syncBudgetMs ?? 0)
    }
  });
  const context: ApplicationContext = buildApplication(env, { disableIssuanceExecution: !(options.execution ?? false) });
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await context.shutdown("test");
    }
  };
  cleanups.push(stop);
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  const database = new PostgresDatabase(env);
  cleanups.push(() => database.close());
  const repository = new PostgresIssuanceOperationRepository(database, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
  const store = new FilesystemContentAddressedArtifactStore(storageRoot);
  const renderer = new NativePdfRenderer();
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;

  async function call(method: string, pathname: string, token: string, body?: unknown, key: string | null = crypto.randomUUID()) {
    const headers: Record<string, string> = { Authorization: bearer(token), "X-Correlation-Id": "req-b3-test" };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (key !== null) {
      headers["Idempotency-Key"] = key;
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, headers: response.headers };
  }

  const harness = {
    env,
    context,
    stop,
    database,
    repository,
    store,
    renderer,
    sql,
    call,
    storageRoot,
    connectionString,
    /** A manual worker with the real body (or test doubles for one dependency). */
    worker(overrides: { owner?: string; renderer?: PdfRendererPort; store?: ContentAddressedArtifactStore; repository?: PostgresIssuanceOperationRepository } = {}) {
      const repo = overrides.repository ?? repository;
      return new IssuanceWorker(
        repo,
        createIssuanceAttemptBody({ repository: repo, renderer: overrides.renderer ?? renderer, store: overrides.store ?? store, logger: silent }),
        { isShuttingDown: false },
        { leaseOwner: overrides.owner ?? `worker-${crypto.randomUUID()}`, leaseMs: LEASE_MS, maxClaimsPerTick: 1 },
        silent
      );
    },
    createAndIssue: (key: string = crypto.randomUUID(), body: AnyRecord = example("create-and-issue.request.json")) =>
      call("POST", "/v2/quotes", TEST_TOKENS.sales, body, key),
    async draftIssue(customer?: AnyRecord, issueKey: string = crypto.randomUUID()) {
      const draftBody = example("draft-create.request.json");
      const draft = await call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, customer ? { ...draftBody, customer } : draftBody);
      expect(draft.status).toBe(201);
      return { draft: draft.body, issued: await call("POST", `/v2/quotes/${draft.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 }, issueKey) };
    },
    async accepted(): Promise<{ quoteId: string; operationId: string }> {
      const response = await harness.createAndIssue();
      expect(response.status).toBe(202);
      return { quoteId: response.body.quote.quoteId, operationId: response.body.operation.operationId };
    },
    async travel(text: string, values: unknown[] = []): Promise<void> {
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      await admin.query(text, values);
      await admin.query("commit");
    },
    expireLease: (operationId: string) =>
      sql(`update quote_service.issuance_operations set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = $1`, [operationId]),
    async op(operationId: string): Promise<AnyRecord> {
      return (await sql(`select *, generation::text as generation from quote_service.issuance_operations where operation_id = $1`, [operationId]))[0]!;
    },
    async quote(quoteId: string): Promise<AnyRecord> {
      return (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    manifests: (quoteId: string) => sql(`select *, byte_length::text as byte_length from quote_service.quote_documents where quote_id = $1`, [quoteId]),
    events: (quoteId: string, type: string) =>
      sql(`select principal_id, operation_id, correlation_id, from_status, to_status, data from quote_service.quote_audit_events where quote_id = $1 and event_type = $2 order by sequence`, [quoteId, type]),
    async counts(): Promise<AnyRecord> {
      return (
        await sql(
          `select (select count(*)::int from quote_service.quotes) as quotes,
                  (select count(*)::int from quote_service.issuance_operations) as operations,
                  (select count(*)::int from quote_service.issuance_operations where status = 'succeeded') as succeeded,
                  (select count(*)::int from quote_service.quote_documents) as documents,
                  (select last_value::text from quote_service.quote_number_seq) as sequence`
        )
      )[0]!;
    },
    /** Every file under the storage root, relative, sorted. */
    files(): string[] {
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
      return out.filter((file) => !file.startsWith("artifacts/tmp/probe-")).sort();
    },
    /** The exact PDF the real renderer produces for this operation's frozen snapshot. */
    async expectedPdf(operationId: string): Promise<Buffer> {
      return renderer.renderPdf(buildIssuedQuoteDocumentModelV2(await repository.loadVerifiedSnapshot(operationId)));
    }
  };

  return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

const fenceOf = (attempt: ClaimedAttempt): OperationFence => ({ operationId: attempt.operationId, generation: attempt.generation, leaseOwner: attempt.leaseOwner });

async function claim(harness: Harness, owner: string): Promise<ClaimedAttempt> {
  const result = await harness.repository.claimNext(owner);
  expect(result.kind).toBe("CLAIMED");
  return (result as { attempt: ClaimedAttempt }).attempt;
}

async function publishFor(harness: Harness, operationId: string) {
  return harness.store.publish(await harness.expectedPdf(operationId));
}

function documentInput(attempt: ClaimedAttempt, published: { pdfSha256: string; byteLength: number; storageKey: string }) {
  return {
    semanticSnapshotHash: attempt.snapshotHash,
    pdfSha256: published.pdfSha256,
    byteLength: published.byteLength,
    storageKey: published.storageKey,
    rendererVersion: RENDERER_VERSION,
    templateVersion: "quote-pdf-template-v4"
  };
}

async function expectIssuedOnce(harness: Harness, quoteId: string, operationId: string) {
  const [manifest, ...others] = await harness.manifests(quoteId);
  expect(others).toEqual([]);
  expect(manifest).toBeDefined();
  expect(await harness.op(operationId)).toMatchObject({ status: "succeeded", lease_owner: null, lease_expires_at: null });
  expect((await harness.quote(quoteId)).status).toBe("issued");
  const bytes = fs.readFileSync(path.join(harness.storageRoot, ...String(manifest!.storage_key).split("/")));
  expect(sha256(bytes)).toBe(manifest!.pdf_sha256);
  expect(String(bytes.byteLength)).toBe(manifest!.byte_length);
  return manifest!;
}

describe("T5: publish + fenced manifest commit", () => {
  it(
    "L–Q, W, X: the worker issues an accepted quote: complete manifest, operation succeeded, quote issued v+1, one audit event, PDF only",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.accepted();
      const before = await harness.quote(quoteId);
      const op = await harness.op(operationId);

      expect(await harness.worker().tick()).toBe(1);

      const manifest = await expectIssuedOnce(harness, quoteId, operationId);
      const after = await harness.quote(quoteId);
      const done = await harness.op(operationId);
      const expected = await harness.expectedPdf(operationId);

      expect(manifest).toMatchObject({
        quote_id: quoteId,
        operation_id: operationId,
        origin: "issuance",
        content_type: "application/pdf",
        semantic_snapshot_hash: op.snapshot_hash,
        semantic_hash_algorithm: "jcs-sha256-v2",
        pdf_sha256: sha256(expected),
        byte_length: String(expected.byteLength),
        renderer_version: RENDERER_VERSION,
        template_version: "quote-pdf-template-v4",
        storage_key: `artifacts/sha256/${sha256(expected).slice(0, 2)}/${sha256(expected).slice(2, 4)}/${sha256(expected)}.pdf`,
        artifact_ref: `sha256:${sha256(expected)}`
      });
      // W: the manifest's semantic hash is the accepted one, recomputable from the frozen snapshot.
      expect(manifest.semantic_snapshot_hash).toBe(issuedSnapshotHash(await harness.repository.loadVerifiedSnapshot(operationId)));
      // generatedAt = committedAt = completedAt = quote updatedAt (one commit instant); issuedAt is untouched.
      expect(manifest.generated_at).toEqual(manifest.committed_at);
      expect(manifest.generated_at).toEqual(done.completed_at);
      expect(after.updated_at).toEqual(done.completed_at);
      expect(after.issued_at).toEqual(before.issued_at);
      expect(after).toMatchObject({ status: "issued", version: before.version + 1, quote_number: before.quote_number });
      expect(done).toMatchObject({ status: "succeeded", generation: "1", attempt_count: 1, next_attempt_at: null });

      expect(await harness.events(quoteId, "quote.issued")).toEqual([
        {
          principal_id: "system",
          operation_id: operationId,
          correlation_id: null,
          from_status: "issuing",
          to_status: "issued",
          data: {
            quoteNumber: before.quote_number,
            version: before.version + 1,
            pdfSha256: manifest.pdf_sha256,
            byteLength: expected.byteLength,
            rendererVersion: RENDERER_VERSION,
            templateVersion: "quote-pdf-template-v4",
            attempts: 1
          }
        }
      ]);
      // Q: one PDF at its content address; no HTML, no other artifact, no temp left behind.
      expect(harness.files()).toEqual([manifest.storage_key]);

      const read = await harness.call("GET", `/v2/quotes/${quoteId}`, TEST_TOKENS.sales, undefined, null);
      expect(read.body).toMatchObject({
        status: "issued",
        document: { available: true, pdfSha256: manifest.pdf_sha256, byteLength: expected.byteLength, rendererVersion: RENDERER_VERSION, templateVersion: "quote-pdf-template-v4", artifactRef: manifest.artifact_ref }
      });
      expect(read.body.document.generatedAt).toBe((manifest.generated_at as Date).toISOString().replace(".000Z", "Z"));
    },
    TEST_TIMEOUT_MS
  );

  it(
    "R/S/T/U/V: stale generation, wrong holder, non-current operation, cancelled or already-issued quote cannot commit",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.accepted();
      const a = await claim(harness, "worker-a");
      const published = await publishFor(harness, operationId);
      await harness.expireLease(operationId);
      const b = await claim(harness, "worker-b");
      const before = { op: await harness.op(operationId), quote: await harness.quote(quoteId), counts: await harness.counts() };

      // R: stale generation; S: right generation, wrong holder.
      expect(await harness.repository.commitIssued(fenceOf(a), documentInput(a, published))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.repository.commitIssued({ ...fenceOf(b), leaseOwner: "intruder" }, documentInput(b, published))).toEqual({ kind: "STALE_FENCE" });
      expect({ op: await harness.op(operationId), quote: await harness.quote(quoteId), counts: await harness.counts() }).toEqual(before);

      expect((await harness.repository.commitIssued(fenceOf(b), documentInput(b, published))).kind).toBe("COMMITTED");
      // V: the same (now succeeded) holder cannot commit a second document.
      expect(await harness.repository.commitIssued(fenceOf(b), documentInput(b, published))).toEqual({ kind: "STALE_FENCE" });
      await expectIssuedOnce(harness, quoteId, operationId);

      // U: a cancelled quote cannot be issued.
      const cancelled = await harness.accepted();
      const c = await claim(harness, "worker-c");
      await harness.travel(
        `update quote_service.quotes set status = 'cancelled', cancelled_at = now(), cancellation_reason_code = 'test_fixture', cancellation_initiated_by = 'sales-integration' where quote_id = $1`,
        [cancelled.quoteId]
      );
      expect(await harness.repository.commitIssued(fenceOf(c), documentInput(c, await publishFor(harness, cancelled.operationId)))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.manifests(cancelled.quoteId)).toEqual([]);

      // T: a running operation that is no longer the quote's current one.
      const stale = await harness.accepted();
      const d = await claim(harness, "worker-d");
      const otherOperation = crypto.randomUUID();
      await harness.travel(
        `insert into quote_service.issuance_operations (operation_id, quote_id, operation_type, origin, retry_of_operation_id, status, generation, attempt_count,
           last_error_code, next_attempt_at, accepted_at, deadline_at, completed_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at)
         select $1, quote_id, 'quote.issue', 'operator_retry', operation_id, 'failed', 0, 0, 'document_generation_failed', null, now(),
                now() + interval '1 hour', now(), snapshot_hash, snapshot_hash_algorithm, now(), now()
           from quote_service.issuance_operations where operation_id = $2`,
        [otherOperation, stale.operationId]
      );
      await harness.travel(`update quote_service.quotes set current_operation_id = $2 where quote_id = $1`, [stale.quoteId, otherOperation]);
      expect(await harness.repository.commitIssued(fenceOf(d), documentInput(d, await publishFor(harness, stale.operationId)))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.manifests(stale.quoteId)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});

describe("crash windows and failures (B3 scope)", () => {
  it(
    "AD (§16): zombie A publishes, loses its lease, B reclaims and issues; A's later T5 has zero effect; files intact",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.accepted();
      let releaseA!: () => void;
      const aPaused = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let aPublished!: () => void;
      const aReachedCommit = new Promise<void>((resolve) => {
        aPublished = resolve;
      });
      const pausingStore: ContentAddressedArtifactStore = {
        publish: async (bytes) => {
          const published = await harness.store.publish(bytes);
          aPublished();
          await aPaused;
          return published;
        }
      };
      const zombie = harness.worker({ owner: "worker-a", store: pausingStore }).tick();
      await aReachedCommit;

      await harness.expireLease(operationId);
      expect(await harness.worker({ owner: "worker-b" }).tick()).toBe(1);
      const manifest = await expectIssuedOnce(harness, quoteId, operationId);
      const fileBefore = fs.readFileSync(path.join(harness.storageRoot, ...String(manifest.storage_key).split("/")));
      const state = { op: await harness.op(operationId), quote: await harness.quote(quoteId), counts: await harness.counts() };

      releaseA();
      expect(await zombie).toBe(1);

      expect({ op: await harness.op(operationId), quote: await harness.quote(quoteId), counts: await harness.counts() }).toEqual(state);
      expect(state.op).toMatchObject({ generation: "2", status: "succeeded" });
      expect(fs.readFileSync(path.join(harness.storageRoot, ...String(manifest.storage_key).split("/"))).equals(fileBefore)).toBe(true);
      // Deterministic renderer: both holders produced the same bytes, so one file exists.
      expect(harness.files()).toEqual([manifest.storage_key]);
      expect(await harness.events(quoteId, "quote.issued")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AA/AB: crash after publication, before T5 → the reclaim reuses the same artifact and issues exactly once",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.accepted();
      await claim(harness, "crashed-worker");
      const orphan = await publishFor(harness, operationId);
      // Process died here: no commit, no failure write. The DB knows nothing about the file.
      expect(await harness.manifests(quoteId)).toEqual([]);
      expect(harness.files()).toEqual([orphan.storageKey]);
      const orphanStat = fs.statSync(path.join(harness.storageRoot, ...orphan.storageKey.split("/")));

      await harness.expireLease(operationId);
      expect(await harness.worker().tick()).toBe(1);

      const manifest = await expectIssuedOnce(harness, quoteId, operationId);
      expect(manifest.storage_key).toBe(orphan.storageKey);
      expect(fs.statSync(path.join(harness.storageRoot, ...orphan.storageKey.split("/"))).mtimeMs).toBe(orphanStat.mtimeMs);
      expect((await harness.op(operationId)).generation).toBe("2");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "Y/Z/AE/AF: render, temp-write, storage and renderer failures before publication → retryable, no manifest, no artifact, quote issuing",
    async () => {
      const harness = await start();
      const cases: Array<[string, Parameters<Harness["worker"]>[0], string, string]> = [
        ["Y render failure", { renderer: { rendererVersion: "x", probe: () => Promise.resolve({ ok: true }), renderPdf: () => Promise.reject(new DocumentRenderError("render_failed")) } }, "document_generation_failed", "render_failed"],
        [
          "Z temp write failure",
          {
            store: new FilesystemContentAddressedArtifactStore(harness.storageRoot, {
              fs: { open: () => Promise.reject(Object.assign(new Error("no space"), { code: "ENOSPC" })) }
            })
          },
          "document_storage_failed",
          "storage_unavailable"
        ],
        [
          "AE storage unavailable (link I/O error)",
          { store: new FilesystemContentAddressedArtifactStore(harness.storageRoot, { fs: { link: () => Promise.reject(Object.assign(new Error("io"), { code: "EIO" })) } }) },
          "document_storage_failed",
          "storage_unavailable"
        ],
        ["AF renderer unavailable", { renderer: new NativePdfRenderer({ assetPaths: { regular: path.join(harness.storageRoot, "missing.ttf") } }) }, "dependency_unavailable", "renderer_unavailable"]
      ];

      for (const [name, overrides, errorCode, reason] of cases) {
        const { quoteId, operationId } = await harness.accepted();
        expect(await harness.worker(overrides).tick(), name).toBe(1);

        expect(await harness.op(operationId), name).toMatchObject({ status: "pending", last_error_code: errorCode, completed_at: null });
        expect((await harness.quote(quoteId)).status, name).toBe("issuing");
        expect(await harness.manifests(quoteId), name).toEqual([]);
        expect((await harness.events(quoteId, "quote.issue.attempt_failed"))[0]?.data, name).toMatchObject({ errorCode, reason, attempt: 1 });
        // Not claimable again before its backoff.
        await harness.sql(`update quote_service.issuance_operations set next_attempt_at = clock_timestamp() + interval '1 hour' where operation_id = $1`, [operationId]);
      }

      expect(harness.files().filter((file) => file.startsWith("artifacts/sha256/"))).toEqual([]);
      expect(harness.files().filter((file) => file.startsWith("artifacts/tmp/"))).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AC: T5 COMMIT outcome unknown is reconciled from durable state (committed → success; not committed → retried once, never guessed)",
    async () => {
      const harness = await start();

      /** Makes the next `count` transactions lose their COMMIT result (after committing, or after a forced rollback). */
      function ambiguous(mode: "committed" | "rolled_back") {
        let armed = 0;
        const db: Pick<PostgresDatabase, "withTransaction" | "query"> = {
          query: harness.database.query.bind(harness.database),
          async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
            if (armed === 0) {
              return harness.database.withTransaction(work);
            }

            armed -= 1;

            if (mode === "committed") {
              await harness.database.withTransaction(work);
              throw new CommitOutcomeUnknownError(new Error("connection lost during COMMIT"));
            }

            const marker = new Error("rollback");
            await harness.database.withTransaction(async (client) => {
              await work(client);
              throw marker;
            }).catch((error: unknown) => {
              if (error !== marker) {
                throw error;
              }
            });
            throw new CommitOutcomeUnknownError(new Error("connection lost during COMMIT"));
          }
        };
        return { db, arm: (count: number) => void (armed = count) };
      }

      // Committed, but the client could not tell: reconciled as success, no failure write.
      const committed = ambiguous("committed");
      const committedRepo = new PostgresIssuanceOperationRepository(committed.db, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
      const first = await harness.accepted();
      const armingStore: ContentAddressedArtifactStore = {
        publish: async (bytes) => {
          const published = await harness.store.publish(bytes);
          committed.arm(1);
          return published;
        }
      };
      expect(await harness.worker({ repository: committedRepo, store: armingStore }).tick()).toBe(1);
      await expectIssuedOnce(harness, first.quoteId, first.operationId);
      expect(await harness.events(first.quoteId, "quote.issue.attempt_failed")).toEqual([]);

      // Not committed and still ours: the commit is retried once and succeeds.
      const once = ambiguous("rolled_back");
      const onceRepo = new PostgresIssuanceOperationRepository(once.db, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
      const second = await harness.accepted();
      expect(
        await harness.worker({ repository: onceRepo, store: { publish: async (bytes) => { const p = await harness.store.publish(bytes); once.arm(1); return p; } } }).tick()
      ).toBe(1);
      await expectIssuedOnce(harness, second.quoteId, second.operationId);

      // Still ambiguous after the retry: abandoned (no success, no failure), recovered later by reclaim.
      const twice = ambiguous("rolled_back");
      const twiceRepo = new PostgresIssuanceOperationRepository(twice.db, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
      const third = await harness.accepted();
      expect(
        await harness.worker({ repository: twiceRepo, store: { publish: async (bytes) => { const p = await harness.store.publish(bytes); twice.arm(2); return p; } } }).tick()
      ).toBe(1);
      expect(await harness.op(third.operationId)).toMatchObject({ status: "running", last_error_code: null });
      expect(await harness.manifests(third.quoteId)).toEqual([]);
      await harness.expireLease(third.operationId);
      expect(await harness.worker().tick()).toBe(1);
      await expectIssuedOnce(harness, third.quoteId, third.operationId);
      expect((await harness.counts()).documents).toBe(3);
    },
    TEST_TIMEOUT_MS
  );
});

describe("amendment A5 (contract): non-retryable attempt failures", () => {
  it(
    "T12: an unsupported glyph fails the operation at once (document_generation_failed), quote stays issuing; T11 cancel and T10 retry remain available",
    async () => {
      const harness = await start();
      const { draft, issued } = await harness.draftIssue({ kind: "person", displayName: "Cliente 漢字" });
      expect(issued.status).toBe(202);
      const quoteId = draft.quoteId;
      const operationId = issued.body.operation.operationId;

      expect(await harness.worker().tick()).toBe(1);

      const op = await harness.op(operationId);
      expect(op).toMatchObject({ status: "failed", last_error_code: "document_generation_failed", next_attempt_at: null, lease_owner: null, attempt_count: 1 });
      expect(op.completed_at.getTime()).toBeLessThan(op.deadline_at.getTime());
      expect(await harness.quote(quoteId)).toMatchObject({ status: "issuing", version: 2 });
      expect(await harness.manifests(quoteId)).toEqual([]);
      expect(await harness.events(quoteId, "quote.issue.failed")).toEqual([
        {
          principal_id: "system",
          operation_id: operationId,
          correlation_id: null,
          from_status: "issuing",
          to_status: "issuing",
          data: { errorCode: "document_generation_failed", retryable: false, reason: "unsupported_glyph", attempts: 1, generation: 1 }
        }
      ]);
      expect(await harness.events(quoteId, "quote.issue.attempt_failed")).toEqual([]);
      // Not retried automatically, and not swept again.
      expect(await harness.repository.claimNext("worker-x")).toEqual({ kind: "NONE_AVAILABLE" });
      expect(await harness.repository.failDeadlineExceeded(10)).toEqual([]);

      // The public representation matches the A5 example shape.
      const read = await harness.call("GET", `/v2/operations/${operationId}`, TEST_TOKENS.backoffice, undefined, null);
      expect(Object.keys(read.body).sort()).toEqual(Object.keys(example("operation-failed-non-retryable.json")).sort());
      expect(read.body).toMatchObject({ status: "failed", attempts: { count: 1, lastErrorCode: "document_generation_failed", nextAttemptAt: null } });

      // T10 is available (after a renderer fix an operator retries; here the same font set would fail again).
      const retry = await harness.repository.createOperatorRetry({ quoteId, failedOperationId: operationId, actorPrincipalId: "backoffice" });
      expect(retry.kind).toBe("RETRY_CREATED");
      expect(await harness.worker().tick()).toBe(1);
      const retryId = (retry as { operationId: string }).operationId;
      expect(await harness.op(retryId)).toMatchObject({ status: "failed", last_error_code: "document_generation_failed" });

      // T11: the creator may cancel; the number is kept and no document ever existed.
      const cancel = await harness.call("POST", `/v2/quotes/${quoteId}/cancel`, TEST_TOKENS.backoffice, { expectedVersion: 3, reasonCode: "customer_declined" });
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ status: "cancelled", document: { available: false } });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "T12: different bytes already at the content address are an integrity incident: never overwritten, operation failed (document_storage_failed)",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.accepted();
      const expected = await harness.expectedPdf(operationId);
      const key = `artifacts/sha256/${sha256(expected).slice(0, 2)}/${sha256(expected).slice(2, 4)}/${sha256(expected)}.pdf`;
      const target = path.join(harness.storageRoot, ...key.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "%PDF-truncated");

      expect(await harness.worker().tick()).toBe(1);

      expect(await harness.op(operationId)).toMatchObject({ status: "failed", last_error_code: "document_storage_failed", next_attempt_at: null });
      expect((await harness.quote(quoteId)).status).toBe("issuing");
      expect(await harness.manifests(quoteId)).toEqual([]);
      expect(fs.readFileSync(target, "utf8")).toBe("%PDF-truncated");
      expect((await harness.events(quoteId, "quote.issue.failed"))[0]?.data).toMatchObject({ retryable: false, reason: "artifact_integrity_conflict" });
    },
    TEST_TIMEOUT_MS
  );
});

describe("inline issuance (Idempotency §4.4) and job activation", () => {
  it(
    "AG/AJ: sync budget 0 → 202 issuing; the periodic worker issues it afterwards",
    async () => {
      const harness = await start({ execution: true, syncBudgetMs: 0 });
      const created = await harness.createAndIssue();

      expect(created.status).toBe(202);
      expect(created.body.quote.status).toBe("issuing");
      const { quoteId, operationId } = { quoteId: created.body.quote.quoteId, operationId: created.body.operation.operationId };
      await waitFor(async () => (await harness.quote(quoteId)).status === "issued", 20_000, 100);
      await expectIssuedOnce(harness, quoteId, operationId);
      expect(harness.context.backgroundJobs.status()).toMatchObject({ issuance: { enabled: true }, issuanceDeadlineSweep: { enabled: true } });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AJ: a budget shorter than the attempt → 202, and the attempt it started still completes",
    async () => {
      const harness = await start({ execution: true, syncBudgetMs: 1, pollIntervalMs: 60_000 });
      const created = await harness.createAndIssue();

      expect(created.status).toBe(202);
      const quoteId = created.body.quote.quoteId;
      await waitFor(async () => (await harness.quote(quoteId)).status === "issued", 20_000, 50);
      await expectIssuedOnce(harness, quoteId, created.body.operation.operationId);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AH/AI/AL/AM: healthy large budget → 201 (create) / 200 (draft issue) only after the manifest commit; replays return the same resource; nothing duplicated",
    async () => {
      const harness = await start({ execution: true, syncBudgetMs: 10_000, pollIntervalMs: 60_000 });
      const created = await harness.createAndIssue("create-key-1");

      expect(created.status).toBe(201);
      expect(created.headers.get("location")).toBe(`/v2/quotes/${created.body.quote.quoteId}`);
      expect(created.body.quote).toMatchObject({ status: "issued", document: { available: true, rendererVersion: RENDERER_VERSION } });
      expect(created.body.operation).toMatchObject({ status: "succeeded" });
      const manifest = await expectIssuedOnce(harness, created.body.quote.quoteId, created.body.operation.operationId);
      expect(created.body.quote.document.pdfSha256).toBe(manifest.pdf_sha256);
      // The inline attempt carries the request's trace correlation onto quote.issued.
      expect((await harness.events(created.body.quote.quoteId, "quote.issued"))[0]?.correlation_id).toBe("req-b3-test");

      const { draft, issued } = await harness.draftIssue(undefined, "issue-key-1");
      expect(issued.status).toBe(200);
      expect(issued.body.quote).toMatchObject({ quoteId: draft.quoteId, status: "issued", version: 3, document: { available: true } });
      await expectIssuedOnce(harness, draft.quoteId, issued.body.operation.operationId);
      const before = await harness.counts();

      // AL: replays after issuance answer the same quote, number and operation in their current state.
      const replay = await harness.createAndIssue("create-key-1");
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(replay.body.quote).toMatchObject({ quoteId: created.body.quote.quoteId, quoteNumber: created.body.quote.quoteNumber, status: "issued" });
      expect(replay.body.operation.operationId).toBe(created.body.operation.operationId);
      const issueReplay = await harness.call("POST", `/v2/quotes/${draft.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 }, "issue-key-1");
      expect(issueReplay.status).toBe(200);
      expect(issueReplay.body.operation.operationId).toBe(issued.body.operation.operationId);
      // AM: no second operation, document or number.
      expect(await harness.counts()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AK: concurrent inline requests and the periodic worker race only through claim/fencing: one manifest per quote",
    async () => {
      const harness = await start({ execution: true, syncBudgetMs: 8_000, pollIntervalMs: 500 });
      const responses = await Promise.all(Array.from({ length: 6 }, () => harness.createAndIssue()));

      expect(responses.every((response) => response.status === 201 || response.status === 202)).toBe(true);

      for (const response of responses) {
        await waitFor(async () => (await harness.quote(response.body.quote.quoteId)).status === "issued", 20_000, 100);
        await expectIssuedOnce(harness, response.body.quote.quoteId, response.body.operation.operationId);
      }

      expect(await harness.counts()).toMatchObject({ quotes: 6, operations: 6, succeeded: 6, documents: 6 });
      const generations = await harness.sql(`select generation::int as generation from quote_service.issuance_operations`);
      expect(generations.every((row) => row.generation === 1)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "restart: an issued quote stays stable; a new process issues pending work once and never duplicates",
    async () => {
      const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-issuance-restart-"));
      cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
      const first = await start({ execution: true, syncBudgetMs: 10_000, pollIntervalMs: 60_000, storageRoot });
      const issued = await first.createAndIssue();
      expect(issued.status).toBe(201);
      await first.stop();

      const second = await start({ execution: true, syncBudgetMs: 0, pollIntervalMs: 500, databaseUrl: first.connectionString, storageRoot });
      const pending = await second.createAndIssue();
      expect(pending.status).toBe(202);
      await waitFor(async () => (await second.quote(pending.body.quote.quoteId)).status === "issued", 20_000, 100);

      await expectIssuedOnce(second, issued.body.quote.quoteId, issued.body.operation.operationId);
      await expectIssuedOnce(second, pending.body.quote.quoteId, pending.body.operation.operationId);
      expect(await second.counts()).toMatchObject({ quotes: 2, operations: 2, succeeded: 2, documents: 2 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "readiness: a broken renderer pauses attempts (no claim), the deadline sweep keeps running",
    async () => {
      const harness = await start();
      const { operationId } = await harness.accepted();
      const brokenRendererApp = buildApplication(harness.env, {
        pdfRenderer: new NativePdfRenderer({ assetPaths: { logo: path.join(harness.storageRoot, "missing.png") } })
      });
      cleanups.push(async () => {
        await brokenRendererApp.shutdown("test");
      });
      await brokenRendererApp.app.listen({ host: "127.0.0.1", port: 0 });
      expect(brokenRendererApp.dependencyMonitor.isReady()).toBe(false);
      expect(brokenRendererApp.dependencyMonitor.isPersistenceReady()).toBe(true);

      await brokenRendererApp.issuance!.issuance.runNow();
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", attempt_count: 0 });

      await harness.travel(
        `update quote_service.issuance_operations set deadline_at = clock_timestamp() - interval '1 second', accepted_at = clock_timestamp() - interval '2 hours' where operation_id = $1`,
        [operationId]
      );
      await brokenRendererApp.issuance!.issuanceDeadlineSweep.runNow();
      expect(await harness.op(operationId)).toMatchObject({ status: "failed", last_error_code: "issuance_deadline_exceeded" });
    },
    TEST_TIMEOUT_MS
  );
});
