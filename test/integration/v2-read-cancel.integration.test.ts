/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/app";
import { sha256Jcs } from "../../src/application/quote/canonical-json";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { databaseClock, type QuoteClock } from "../../src/infrastructure/persistence/postgres/quote-clock";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS as SHARED_TOKENS, testRegistryDocument } from "../helpers/test-principals";
import { migrateToV1Head, seedV1Snapshot, V1_IDS } from "../helpers/v1-fixture";

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Response = { status: number; body: AnyRecord; text: string; headers: Headers };

const TEST_TIMEOUT_MS = 60_000;
const TEST_TOKENS = {
  ...SHARED_TOKENS,
  clerk: "test-read-cancel-clerk-own-quotes-token-0123456789abcdefg",
  clerk2: "test-read-cancel-second-clerk-token-0123456789abcdefghijk",
  reader: "test-read-cancel-reader-no-audit-token-0123456789abcdefgh",
  healthOnly: "test-read-cancel-health-only-token-0123456789abcdefghijk"
};
const UNKNOWN_ID = "7d3f0a9e-1b2c-4d5e-8f60-718293a4b5c6";

/**
 * Shared registry plus own-quote principals (no `quotes:read:any`): two clerks
 * that may draft, issue, read, audit and cancel their own quotes, a plain
 * reader without the audit scope, and a health-only principal.
 */
function registry(): PrincipalRegistry {
  const document = testRegistryDocument();
  const ownScopes = ["quotes:draft:write", "quotes:issue", "quotes:read", "quotes:cancel", "quotes:audit:read"];
  document.principals.push(
    { principalId: "clerk", principalType: "operator", scopes: ownScopes, tokenSha256: [sha256Hex(TEST_TOKENS.clerk)] },
    { principalId: "clerk-two", principalType: "operator", scopes: ownScopes, tokenSha256: [sha256Hex(TEST_TOKENS.clerk2)] },
    { principalId: "reader", principalType: "service", scopes: ["quotes:read"], tokenSha256: [sha256Hex(TEST_TOKENS.reader)] },
    {
      principalId: "health-only",
      principalType: "service",
      scopes: ["service:health:dependencies"],
      tokenSha256: [sha256Hex(TEST_TOKENS.healthOnly)]
    }
  );
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}

/** Injected expiry clock: pinned in a test, otherwise the production database clock. */
class TestClock implements QuoteClock {
  pinned: Date | null = null;

  now(queryable: Parameters<QuoteClock["now"]>[0]): Promise<Date> {
    return this.pinned ? Promise.resolve(this.pinned) : databaseClock.now(queryable);
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const QUOTE_KEYS = Object.keys(example("quote-issued.json")).sort();
const OPERATION_KEYS = Object.keys(example("operation-issuing.json")).sort();
const AUDIT_EVENT_KEYS = Object.keys(example("audit.response.json").items[0]).sort();

const draftBody = (externalCorrelation?: AnyRecord): AnyRecord => {
  const body = example("draft-create.request.json");
  return externalCorrelation ? { ...body, externalCorrelation } : body;
};
const cancelBody = (expectedVersion: number, extra: AnyRecord = {}) => ({ expectedVersion, reasonCode: "customer_declined", ...extra });
const withoutRequestId = (body: AnyRecord) => ({ ...body, error: { ...body.error, requestId: undefined } });

interface CallOptions {
  token?: string;
  key?: string | null;
  correlationId?: string;
  body?: unknown;
}

async function start(options: { legacy?: boolean; migrate?: boolean; databaseUrl?: string; logs?: string[] } = {}) {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());

  if (options.legacy) {
    await migrateToV1Head(database.connectionString);
    await seedV1Snapshot(database.connectionString);
  }

  if (options.migrate ?? true) {
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  }

  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-v2-read-cancel-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const clock = new TestClock();
  const context = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: options.databaseUrl ?? database.connectionString,
      storageRoot,
      overrides: { LOG_LEVEL: options.logs ? "trace" : "silent" }
    }),
    {
      principalRegistry: registry(),
      quoteClock: clock,
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {})
    }
  );
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());

  async function call(method: string, pathname: string, { token = TEST_TOKENS.clerk, key = null, correlationId, body }: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: bearer(token) };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (key !== null) {
      headers["Idempotency-Key"] = key;
    }

    if (correlationId !== undefined) {
      headers["X-Correlation-Id"] = correlationId;
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, text, headers: response.headers };
  }

  const sql = async <T extends pg.QueryResultRow = AnyRecord>(text: string, values: unknown[] = []) => (await admin.query<T>(text, values)).rows;

  const harness = {
    context,
    clock,
    sql,
    call,
    connectionString: database.connectionString,
    get: (pathname: string, token: string = TEST_TOKENS.clerk) => call("GET", pathname, { token }),
    lookup: (operation: string, key: string, token: string = TEST_TOKENS.clerk) =>
      call("GET", `/v2/idempotency/current?operation=${operation}`, { token, key }),
    createDraft: (options: CallOptions = {}) => call("POST", "/v2/quotes/drafts", { key: "draft-1", body: draftBody(), ...options }),
    updateDraft: (quoteId: string, options: CallOptions = {}) =>
      call("PATCH", `/v2/quotes/${quoteId}/draft`, { key: "update-1", body: example("draft-update.request.json"), ...options }),
    issue: (quoteId: string, options: CallOptions = {}) =>
      call("POST", `/v2/quotes/${quoteId}/issue`, { key: "issue-1", body: { expectedVersion: 1 }, ...options }),
    cancel: (quoteId: string, options: CallOptions = {}) =>
      call("POST", `/v2/quotes/${quoteId}/cancel`, { key: "cancel-1", body: cancelBody(1), ...options }),
    createAndIssue: (options: CallOptions = {}) =>
      call("POST", "/v2/quotes", { token: TEST_TOKENS.sales, key: "create-1", body: example("create-and-issue.request.json"), ...options }),

    /** A draft of `token` (version 1). */
    async draft(options: CallOptions = {}): Promise<AnyRecord> {
      const created = await harness.createDraft({ key: `draft-${crypto.randomUUID()}`, ...options });
      expect(created.status).toBe(201);
      return created.body;
    },
    /** A draft issued by its creator: `issuing`, version 2, operation pending. */
    async issuing(token: string = TEST_TOKENS.clerk): Promise<{ quoteId: string; operationId: string; quoteNumber: string }> {
      const draft = await harness.draft({ token });
      const issued = await harness.issue(draft.quoteId, { token, key: `issue-${crypto.randomUUID()}` });
      expect(issued.status).toBe(202);
      return { quoteId: draft.quoteId, operationId: issued.body.operation.operationId, quoteNumber: issued.body.quote.quoteNumber };
    },
    /** Simulates the future worker's fenced manifest commit (T5): operation succeeded, manifest, quote issued. */
    async markIssued(quoteId: string): Promise<{ pdfSha256: string; validUntilExclusive: Date }> {
      const [quote] = await sql(`select current_operation_id, valid_until_exclusive from quote_service.quotes where quote_id = $1`, [quoteId]);
      const pdfSha256 = sha256Hex(`pdf-${quoteId}`);
      await admin.query("begin");
      await admin.query(
        `update quote_service.issuance_operations
         set status = 'succeeded', generation = generation + 1, attempt_count = attempt_count + 1, last_attempt_at = now(),
             completed_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
         where operation_id = $1`,
        [quote!.current_operation_id]
      );
      await admin.query(
        `insert into quote_service.quote_documents (
           document_id, quote_id, operation_id, origin, content_type, semantic_snapshot_hash, semantic_hash_algorithm,
           pdf_sha256, byte_length, renderer_version, template_version, generated_at, storage_key, committed_at
         ) select $1, $2, o.operation_id, 'issuance', 'application/pdf', o.snapshot_hash, 'jcs-sha256-v2', $3, 4321,
                  'quote-pdf-v4', 'quote-template-v4', now(),
                  'artifacts/sha256/' || substr($3, 1, 2) || '/' || substr($3, 3, 2) || '/' || $3 || '.pdf', now()
           from quote_service.issuance_operations o where o.operation_id = $4`,
        [crypto.randomUUID(), quoteId, pdfSha256, quote!.current_operation_id]
      );
      await admin.query(`update quote_service.quotes set status = 'issued', version = version + 1, updated_at = now() where quote_id = $1`, [quoteId]);
      await admin.query("commit");
      return { pdfSha256, validUntilExclusive: quote!.valid_until_exclusive };
    },
    /** A lease holder is attempting (claim, §4.3). */
    async markRunning(operationId: string) {
      await sql(
        `update quote_service.issuance_operations
         set status = 'running', generation = generation + 1, attempt_count = attempt_count + 1, lease_owner = 'test-worker',
             lease_expires_at = now() + interval '1 minute', last_attempt_at = now(), updated_at = now()
         where operation_id = $1`,
        [operationId]
      );
    },
    /** Deadline sweep (T6): operation failed, quote stays issuing. */
    async markFailed(operationId: string) {
      await sql(
        `update quote_service.issuance_operations
         set status = 'failed', generation = generation + 1, last_error_code = 'issuance_deadline_exceeded', completed_at = now(),
             lease_owner = null, lease_expires_at = null, updated_at = now()
         where operation_id = $1`,
        [operationId]
      );
    },
    /** Operator retry (T10): a new pending operation becomes current. */
    async operatorRetry(quoteId: string, failedOperationId: string): Promise<string> {
      const operationId = crypto.randomUUID();
      await admin.query("begin");
      await admin.query(
        `insert into quote_service.issuance_operations (
           operation_id, quote_id, operation_type, origin, retry_of_operation_id, status, generation, attempt_count,
           next_attempt_at, accepted_at, deadline_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
         ) select $1, quote_id, 'quote.issue', 'operator_retry', operation_id, 'pending', 0, 0, now(), now(),
                  now() + interval '24 hours', snapshot_hash, snapshot_hash_algorithm, now(), now()
           from quote_service.issuance_operations where operation_id = $2`,
        [operationId, failedOperationId]
      );
      await admin.query(`update quote_service.quotes set current_operation_id = $2, version = version + 1 where quote_id = $1`, [quoteId, operationId]);
      await admin.query("commit");
      return operationId;
    },
    async quoteRow(quoteId: string) {
      return (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    async events(quoteId: string) {
      return sql(
        `select event_type, principal_id, operation_id, correlation_id, idempotency_key_hash, from_status, to_status, data
         from quote_service.quote_audit_events where quote_id = $1 order by sequence`,
        [quoteId]
      );
    },
    async counts() {
      const [counts] = await sql(
        `select (select count(*)::int from quote_service.quotes) as quotes,
                (select count(*)::int from quote_service.issuance_operations) as operations,
                (select count(*)::int from quote_service.idempotency_bindings) as bindings,
                (select count(*)::int from quote_service.quote_documents) as documents,
                (select count(*)::int from quote_service.quote_audit_events) as events,
                (select last_value::text || ':' || is_called::text from quote_service.quote_number_seq) as sequence`
      );
      return counts!;
    },
    /**
     * Holds the quote row lock and starts `requests` one at a time, each only
     * once the previous one is queued on a lock, so every request is truly in
     * flight at release and the lock queue order is the launch order. Then
     * runs `beforeRelease` and releases.
     */
    async raceOnRowLock<T>(quoteId: string, requests: Array<() => Promise<T>>, beforeRelease: () => void = () => undefined): Promise<T[]> {
      const locker = new pg.Client({ connectionString: database.connectionString });
      await locker.connect();
      const waiting = async () =>
        (
          await sql<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
          )
        )[0]!.waiting;

      try {
        await locker.query("begin");
        await locker.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [quoteId]);
        const pending: Array<Promise<T>> = [];

        for (const request of requests) {
          pending.push(request());
          const queued = pending.length;
          await waitFor(async () => (await waiting()) >= queued);
        }

        beforeRelease();
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

const plusMs = (date: Date, ms: number) => new Date(date.getTime() + ms);

describe("GET /v2/quotes/{quoteId}", () => {
  it("A/C/D: creator reads its draft; read:any reads it too; anyone else gets a 404 identical to an unknown quote", async () => {
    const harness = await start();
    const created = await harness.draft();
    const own = await harness.get(`/v2/quotes/${created.quoteId}`);

    expect(own.status).toBe(200);
    expect(own.body).toEqual(created);
    expect(Object.keys(own.body).sort()).toEqual(QUOTE_KEYS);
    expect(own.body).toMatchObject({ status: "draft", version: 1, quoteNumber: null, validity: null, issuance: null });

    // C: read:any extends read visibility.
    const foreignReader = await harness.get(`/v2/quotes/${created.quoteId}`, TEST_TOKENS.backoffice);
    expect(foreignReader.status).toBe(200);
    expect(foreignReader.body).toEqual(created);

    // D: a principal without read:any cannot tell a foreign quote from a missing one.
    const unknown = await harness.get(`/v2/quotes/${UNKNOWN_ID}`, TEST_TOKENS.clerk2);
    for (const token of [TEST_TOKENS.clerk2, TEST_TOKENS.sales, TEST_TOKENS.reader]) {
      const hidden = await harness.get(`/v2/quotes/${created.quoteId}`, token);
      expect(hidden.status).toBe(404);
      expect(withoutRequestId(hidden.body)).toEqual(withoutRequestId(unknown.body));
    }
    expect(unknown.body.error.code).toBe("quote_not_found");
  }, TEST_TIMEOUT_MS);

  it("B/24: an issuing quote reads honestly — number and pending operation, no document, never issued", async () => {
    const harness = await start();
    const { quoteId, operationId, quoteNumber } = await harness.issuing();
    const quote = (await harness.get(`/v2/quotes/${quoteId}`)).body;

    expect(quote).toMatchObject({ status: "issuing", version: 2, quoteNumber, issuance: { operationId }, expiration: null, cancellation: null });
    expect(quote.document).toEqual({
      available: false,
      contentType: "application/pdf",
      semanticSnapshotHash: null,
      pdfSha256: null,
      byteLength: null,
      rendererVersion: null,
      templateVersion: null,
      generatedAt: null,
      artifactRef: null
    });
    const operation = await harness.get(`/v2/operations/${operationId}`);
    expect(operation.status).toBe(200);
    expect(operation.body).toMatchObject({ operationId, quoteId, type: "quote.issue", status: "pending", completedAt: null });
  }, TEST_TIMEOUT_MS);

  it("M: an issued quote exposes the public manifest and nothing internal", async () => {
    const harness = await start();
    const { quoteId, operationId } = await harness.issuing();
    const { pdfSha256 } = await harness.markIssued(quoteId);
    const response = await harness.get(`/v2/quotes/${quoteId}`);
    const quote = response.body;

    expect(Object.keys(quote).sort()).toEqual(QUOTE_KEYS);
    expect(quote).toMatchObject({ status: "issued", version: 3, issuance: { operationId } });
    expect(quote.document).toMatchObject({
      available: true,
      contentType: "application/pdf",
      pdfSha256,
      byteLength: 4321,
      rendererVersion: "quote-pdf-v4",
      templateVersion: "quote-template-v4",
      artifactRef: `sha256:${pdfSha256}`
    });
    expect(Object.keys(quote.document).sort()).toEqual(Object.keys(example("quote-issued.json").document).sort());

    const operation = await harness.get(`/v2/operations/${operationId}`);
    expect(Object.keys(operation.body).sort()).toEqual(OPERATION_KEYS);
    expect(operation.body).toMatchObject({ status: "succeeded", attempts: { count: 1, lastErrorCode: null } });

    // No storage path, lease/fencing internals, override note, request snapshot, raw key or credential.
    const haystack = `${response.text}\n${operation.text}`;
    const rawKeys = await harness.sql<{ key_hash: string }>(`select key_hash from quote_service.idempotency_bindings`);
    for (const secret of [
      "artifacts/sha256",
      "storage",
      "lease",
      "generation",
      "test-worker",
      "requestSnapshot",
      "fingerprint",
      "legacy",
      TEST_TOKENS.clerk,
      sha256Hex(TEST_TOKENS.clerk),
      ...rawKeys.map((row) => row.key_hash)
    ]) {
      expect(haystack).not.toContain(secret);
    }
  }, TEST_TIMEOUT_MS);

  it("400 for a malformed id precedes authentication; 401 without a credential", async () => {
    const harness = await start();
    expect((await harness.get(`/v2/quotes/not-a-uuid`, "wrong-token")).body.error.code).toBe("invalid_request");
    expect((await harness.get(`/v2/quotes/${UNKNOWN_ID}`, "wrong-token")).status).toBe(401);
    expect((await harness.get(`/v2/operations/not-a-uuid`)).status).toBe(400);
    expect((await harness.get(`/v2/quotes/${UNKNOWN_ID}`, TEST_TOKENS.healthOnly)).body.error).toMatchObject({
      code: "forbidden",
      details: { requiredScope: "quotes:read" }
    });
  }, TEST_TIMEOUT_MS);
});

describe("effective expiry projection", () => {
  it("N/O/P/Q/S/T: issued before, at and after validUntilExclusive, from the injected clock, consistent across endpoints", async () => {
    const harness = await start();
    const { quoteId } = await harness.issuing();
    const { validUntilExclusive: boundary } = await harness.markIssued(quoteId);
    const correlation = draftBody().externalCorrelation;
    const listPath = (status: string) =>
      `/v2/quotes?sourceSystem=${correlation.sourceSystem}&externalReferenceType=${correlation.externalReferenceType}` +
      `&externalReference=${correlation.externalReference}&status=${status}`;

    const observe = async () => {
      const quote = (await harness.get(`/v2/quotes/${quoteId}`)).body;
      const issued = (await harness.get(listPath("issued"))).body.items.map((item: AnyRecord) => item.quoteId);
      const expired = (await harness.get(listPath("expired"))).body.items.map((item: AnyRecord) => item.quoteId);
      const all = (await harness.get(listPath("issued").replace("&status=issued", ""))).body.items;
      return { quote, issued, expired, listed: all.find((item: AnyRecord) => item.quoteId === quoteId) };
    };

    // N: one millisecond before the boundary (wall clock is days earlier: only the injected clock can say this).
    harness.clock.pinned = plusMs(boundary, -1);
    let seen = await observe();
    expect(seen.quote).toMatchObject({ status: "issued", expiration: null });
    expect(seen.issued).toEqual([quoteId]);
    expect(seen.expired).toEqual([]);
    expect(seen.listed).toEqual(seen.quote);

    // O/Q: exactly at the boundary → expired, expiredAt = validUntilExclusive (not "now").
    harness.clock.pinned = boundary;
    seen = await observe();
    expect(seen.quote).toMatchObject({ status: "expired", expiration: { expiredAt: seen.quote.validity.validUntilExclusive } });
    expect(new Date(seen.quote.expiration.expiredAt).getTime()).toBe(boundary.getTime());
    expect(seen.issued).toEqual([]);
    expect(seen.expired).toEqual([quoteId]);
    expect(seen.listed).toEqual(seen.quote);

    // P: well after → still expiredAt = boundary.
    harness.clock.pinned = plusMs(boundary, 86_400_000);
    seen = await observe();
    expect(seen.quote.status).toBe("expired");
    expect(seen.quote.expiration.expiredAt).toBe(seen.quote.validity.validUntilExclusive);
    expect(seen.listed).toEqual(seen.quote);
  }, TEST_TIMEOUT_MS);

  it("R: the projection never writes — row, version, updatedAt and manifest unchanged; issuing does not project", async () => {
    const harness = await start();
    const { quoteId } = await harness.issuing();
    const pending = await harness.issuing();
    const { validUntilExclusive: boundary } = await harness.markIssued(quoteId);
    const before = await harness.quoteRow(quoteId);
    const manifestBefore = await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [quoteId]);
    const countsBefore = await harness.counts();

    harness.clock.pinned = plusMs(boundary, 1);
    expect((await harness.get(`/v2/quotes/${quoteId}`)).body.status).toBe("expired");
    // An issuing quote past its validity stays issuing until its manifest commits (state machine §3 notes).
    expect((await harness.get(`/v2/quotes/${pending.quoteId}`)).body).toMatchObject({ status: "issuing", expiration: null });

    expect(await harness.quoteRow(quoteId)).toEqual(before);
    expect(before).toMatchObject({ status: "issued", expired_at: null });
    expect(await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [quoteId])).toEqual(manifestBefore);
    expect(await harness.counts()).toEqual(countsBefore);
  }, TEST_TIMEOUT_MS);
});

describe("GET /v2/quotes (external correlation)", () => {
  const ref = (reference: string) => ({ sourceSystem: "backoffice", externalReferenceType: "case", externalReference: reference });
  const listPath = (query: string) => `/v2/quotes?${query}`;
  const ids = (response: Response) => response.body.items.map((item: AnyRecord) => item.quoteId);

  it("E/F/G: exact correlation match, own quotes only, read:any sees every principal's", async () => {
    const harness = await start();
    const mineA1 = (await harness.draft({ body: draftBody(ref("CASE-A")) })).quoteId;
    const mineA2 = (await harness.draft({ body: draftBody(ref("CASE-A")) })).quoteId;
    const mineB = (await harness.draft({ body: draftBody(ref("CASE-B")) })).quoteId;
    const mineOther = (await harness.draft({ body: draftBody({ sourceSystem: "other-system" }) })).quoteId;
    const foreignA = (await harness.draft({ token: TEST_TOKENS.clerk2, body: draftBody(ref("CASE-A")) })).quoteId;
    const caseA = "sourceSystem=backoffice&externalReferenceType=case&externalReference=CASE-A";

    // E + F: exact match, newest first, foreign rows excluded in SQL.
    const own = await harness.get(listPath(caseA));
    expect(own.status).toBe(200);
    expect(Object.keys(own.body).sort()).toEqual(["items", "nextCursor"]);
    expect(ids(own)).toEqual([mineA2, mineA1]);
    expect(own.body.nextCursor).toBeNull();
    expect(ids(await harness.get(listPath("sourceSystem=backoffice")))).toEqual([mineB, mineA2, mineA1]);
    expect(ids(await harness.get(listPath("sourceSystem=other-system")))).toEqual([mineOther]);
    expect(ids(await harness.get(listPath("sourceSystem=backoffice&externalReferenceType=case&externalReference=CASE")))).toEqual([]);

    // G: read:any includes authorized foreign rows; the other clerk sees only its own.
    expect(ids(await harness.get(listPath(caseA), TEST_TOKENS.backoffice))).toEqual([foreignA, mineA2, mineA1]);
    expect(ids(await harness.get(listPath(caseA), TEST_TOKENS.clerk2))).toEqual([foreignA]);

    // Items are full Quote representations, identical to GET.
    expect(own.body.items[0]).toEqual((await harness.get(`/v2/quotes/${mineA2}`)).body);
  }, TEST_TIMEOUT_MS);

  it("H: keyset pagination is stable with equal createdAt, ignores later inserts, and validates its cursor", async () => {
    const harness = await start();
    const createdAt = "2026-10-01T12:00:00.123456Z";
    const inserted: string[] = [];

    for (let index = 0; index < 7; index += 1) {
      const quoteId = crypto.randomUUID();
      inserted.push(quoteId);
      await harness.sql(
        `insert into quote_service.quotes (quote_id, status, version, currency, source_system, external_reference_type, external_reference,
           customer, net_amount, tax_amount, gross_amount, exempt_net_amount, created_by_principal_id, created_at, updated_at)
         values ($1, 'draft', 1, 'CLP', 'paging', 'case', 'P-1', '{"kind":"guest"}', 0, 0, 0, 0, 'clerk', $2, $2)`,
        [quoteId, index < 5 ? createdAt : `2026-10-0${index - 3}T00:00:00Z`]
      );
    }

    const expected = (
      await harness.sql<{ quote_id: string }>(
        `select quote_id from quote_service.quotes where source_system = 'paging' order by created_at desc, quote_id desc`
      )
    ).map((row) => row.quote_id);
    const base = "/v2/quotes?sourceSystem=paging&externalReferenceType=case&externalReference=P-1&limit=2";
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Response = await harness.get(cursor ? `${base}&cursor=${cursor}` : base);
      expect(page.status).toBe(200);
      seen.push(...ids(page));
      cursor = page.body.nextCursor;
      pages += 1;

      if (pages === 1) {
        // A newer quote created between pages never shifts the remaining pages.
        await harness.draft({ body: draftBody({ sourceSystem: "paging", externalReferenceType: "case", externalReference: "P-1" }) });
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    } while (cursor !== null);

    expect(pages).toBe(4);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(7);

    // Invalid, tampered or foreign-query cursors and bad parameters are 400.
    const first = (await harness.get(base)).body.nextCursor as string;
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first, "base64url").toString()), id: "x" })).toString("base64url");
    for (const query of [
      `${base}&cursor=${tampered}`,
      `${base}&cursor=bm90LWpzb24`,
      `/v2/quotes?sourceSystem=paging&limit=2&cursor=${first}`,
      "/v2/quotes?sourceSystem=paging&limit=51",
      "/v2/quotes?sourceSystem=paging&limit=0",
      "/v2/quotes?sourceSystem=paging&externalReferenceType=case",
      "/v2/quotes?sourceSystem=Not_A_Code",
      "/v2/quotes?sourceSystem=paging&status=accepted",
      "/v2/quotes?sourceSystem=a&sourceSystem=b",
      "/v2/quotes"
    ]) {
      const response = await harness.get(query);
      expect([query, response.status, response.body.error?.code]).toEqual([query, 400, "invalid_request"]);
    }
  }, TEST_TIMEOUT_MS);
});

describe("GET /v2/operations/{operationId}", () => {
  it("I/J/K/9: visible to the creator and read:any, hidden otherwise; operation and quote lifecycles stay separate", async () => {
    const harness = await start();
    const { quoteId, operationId } = await harness.issuing();
    const own = await harness.get(`/v2/operations/${operationId}`);

    expect(own.status).toBe(200);
    expect(Object.keys(own.body).sort()).toEqual(OPERATION_KEYS);
    expect((await harness.get(`/v2/operations/${operationId}`, TEST_TOKENS.backoffice)).body).toEqual(own.body);

    const unknown = await harness.get(`/v2/operations/${UNKNOWN_ID}`, TEST_TOKENS.clerk2);
    expect(unknown.body.error.code).toBe("operation_not_found");
    for (const token of [TEST_TOKENS.clerk2, TEST_TOKENS.sales]) {
      const hidden = await harness.get(`/v2/operations/${operationId}`, token);
      expect(hidden.status).toBe(404);
      expect(withoutRequestId(hidden.body)).toEqual(withoutRequestId(unknown.body));
    }

    // A failed operation is not a cancelled quote.
    await harness.markFailed(operationId);
    expect((await harness.get(`/v2/operations/${operationId}`)).body).toMatchObject({
      status: "failed",
      attempts: { lastErrorCode: "issuance_deadline_exceeded" }
    });
    expect((await harness.get(`/v2/quotes/${quoteId}`)).body).toMatchObject({ status: "issuing", cancellation: null, issuance: { operationId } });
  }, TEST_TIMEOUT_MS);
});

describe("GET /v2/quotes/{quoteId}/audit", () => {
  it("L: same visibility as the quote, audit scope required, sequence order, cursor pages", async () => {
    const harness = await start();
    const draft = await harness.draft({ correlationId: "trace-audit-1" });
    await harness.updateDraft(draft.quoteId, { key: "audit-update", body: { expectedVersion: 1, lines: draftBody().lines } });
    await harness.issue(draft.quoteId, { key: "audit-issue", body: { expectedVersion: 2 } });
    const auditPath = `/v2/quotes/${draft.quoteId}/audit`;
    const all = await harness.get(auditPath);

    expect(all.status).toBe(200);
    expect(all.body.items.map((event: AnyRecord) => [event.sequence, event.type, event.fromStatus, event.toStatus])).toEqual([
      [1, "quote.draft.created", null, "draft"],
      [2, "quote.draft.updated", "draft", "draft"],
      [3, "quote.issue.accepted", "draft", "issuing"]
    ]);
    expect(Object.keys(all.body.items[0]).sort()).toEqual(AUDIT_EVENT_KEYS);
    expect(all.body.items[0]).toMatchObject({ principalId: "clerk", correlationId: "trace-audit-1", idempotencyKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(all.body.nextCursor).toBeNull();

    const paged: AnyRecord[] = [];
    let cursor: string | null = null;
    do {
      const page: Response = await harness.get(`${auditPath}?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      paged.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(all.body.items);

    expect((await harness.get(auditPath, TEST_TOKENS.backoffice)).body).toEqual(all.body);
    const unknown = await harness.get(`/v2/quotes/${UNKNOWN_ID}/audit`, TEST_TOKENS.clerk2);
    const hidden = await harness.get(auditPath, TEST_TOKENS.clerk2);
    expect(hidden.status).toBe(404);
    expect(withoutRequestId(hidden.body)).toEqual(withoutRequestId(unknown.body));
    expect((await harness.get(auditPath, TEST_TOKENS.reader)).body.error).toMatchObject({ code: "forbidden", details: { requiredScope: "quotes:audit:read" } });

    // A cursor of one quote is not valid for another.
    const firstPage = await harness.get(`${auditPath}?limit=1`);
    const other = await harness.draft();
    expect((await harness.get(`/v2/quotes/${other.quoteId}/audit?cursor=${firstPage.body.nextCursor}`)).status).toBe(400);

    // M: no PII, raw key or credential in audit.
    for (const secret of ["Gimnasio", "Pedro", "compras@", "76123456", "audit-update", "audit-issue", TEST_TOKENS.clerk]) {
      expect(all.text).not.toContain(secret);
    }
  }, TEST_TIMEOUT_MS);
});

describe("GET /v2/idempotency/current", () => {
  it("U/V/W/X/Y: each binding reconciles to the same resource and reports its current state", async () => {
    const harness = await start();

    // U: create-and-issue.
    const created = await harness.createAndIssue();
    const createLookup = await harness.lookup("quote.create_and_issue", "create-1", TEST_TOKENS.sales);
    expect(createLookup.status).toBe(200);
    expect(createLookup.body).toEqual({
      operation: "quote.create_and_issue",
      state: "bound",
      binding: {
        boundAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/),
        requestFingerprint: sha256Jcs({ operation: "quote.create_and_issue", pathParameters: {}, body: example("create-and-issue.request.json") }),
        resourceType: "quote",
        quoteId: created.body.quote.quoteId,
        operationId: created.body.operation.operationId,
        deliveryId: null,
        quoteStatus: "issuing"
      }
    });
    expect(Object.keys(createLookup.body.binding).sort()).toEqual(Object.keys(example("idempotency-lookup.bound.json").binding).sort());

    // V: draft create; W: draft update; X: issue — same quoteId throughout, operationId only for issue.
    const draft = await harness.createDraft({ key: "lk-draft" });
    await harness.updateDraft(draft.body.quoteId, { key: "lk-update", body: { expectedVersion: 1, lines: draftBody().lines } });
    const issued = await harness.issue(draft.body.quoteId, { key: "lk-issue", body: { expectedVersion: 2 } });
    const binding = async (operation: string, key: string) => (await harness.lookup(operation, key)).body.binding;

    expect(await binding("quote.draft.create", "lk-draft")).toMatchObject({ quoteId: draft.body.quoteId, operationId: null, quoteStatus: "issuing" });
    expect(await binding("quote.draft.update", "lk-update")).toMatchObject({ quoteId: draft.body.quoteId, operationId: null, quoteStatus: "issuing" });
    expect(await binding("quote.issue", "lk-issue")).toMatchObject({
      quoteId: draft.body.quoteId,
      operationId: issued.body.operation.operationId,
      quoteStatus: "issuing"
    });

    // Y: the binding never changes; quoteStatus follows the quote (issued → expired by projection).
    const { validUntilExclusive } = await harness.markIssued(draft.body.quoteId);
    expect(await binding("quote.issue", "lk-issue")).toMatchObject({ operationId: issued.body.operation.operationId, quoteStatus: "issued" });
    harness.clock.pinned = validUntilExclusive;
    expect(await binding("quote.draft.create", "lk-draft")).toMatchObject({ quoteStatus: "expired" });
    // 27: every endpoint names the same identifiers.
    const quote = (await harness.get(`/v2/quotes/${draft.body.quoteId}`)).body;
    expect([quote.quoteId, quote.quoteNumber, quote.issuance.operationId]).toEqual([
      issued.body.quote.quoteId,
      issued.body.quote.quoteNumber,
      issued.body.operation.operationId
    ]);

    // Unbound key → not_found; lookup is read-only (no audit, no binding).
    const countsBefore = await harness.counts();
    const notFound = await harness.lookup("quote.issue", "never-used");
    expect(notFound.body).toEqual({ operation: "quote.issue", state: "not_found", binding: null });
    expect(Object.keys(notFound.body).sort()).toEqual(Object.keys(example("idempotency-lookup.not-found.json")).sort());
    expect(await harness.counts()).toEqual(countsBefore);
  }, TEST_TIMEOUT_MS);

  it("Z/AA: scope is the authenticated principal only; raw keys are never returned or logged", async () => {
    const logs: string[] = [];
    const harness = await start({ logs });
    const rawKey = "secret-raw-idempotency-key-Z-42";
    const draft = await harness.createDraft({ key: rawKey });

    expect((await harness.lookup("quote.draft.create", rawKey)).body.state).toBe("bound");
    // Another principal with the same key value sees nothing, and no parameter can name a principal.
    for (const token of [TEST_TOKENS.clerk2, TEST_TOKENS.backoffice]) {
      expect((await harness.lookup("quote.draft.create", rawKey, token)).body).toEqual({ operation: "quote.draft.create", state: "not_found", binding: null });
    }
    expect(
      (await harness.call("GET", `/v2/idempotency/current?operation=quote.draft.create&principalId=clerk`, { token: TEST_TOKENS.clerk2, key: rawKey })).body
        .state
    ).toBe("not_found");
    // Same key, other operation: independent.
    expect((await harness.lookup("quote.cancel", rawKey)).body.state).toBe("not_found");

    // 400 → 401 → 403 order; header and operation are mandatory.
    expect((await harness.call("GET", `/v2/idempotency/current?operation=quote.draft.create`, { key: null })).body.error.code).toBe("invalid_request");
    expect((await harness.call("GET", `/v2/idempotency/current?operation=quote.unknown`, { key: rawKey })).status).toBe(400);
    expect((await harness.call("GET", `/v2/idempotency/current`, { key: rawKey })).status).toBe(400);
    expect((await harness.lookup("quote.draft.create", rawKey, "wrong-token")).status).toBe(401);
    expect((await harness.lookup("quote.draft.create", rawKey, TEST_TOKENS.healthOnly)).body.error.details).toEqual({ requiredScope: "quotes:read" });

    const responses = [
      draft,
      await harness.lookup("quote.draft.create", rawKey),
      await harness.get(`/v2/quotes/${draft.body.quoteId}/audit`),
      await harness.get(`/v2/quotes/${draft.body.quoteId}`)
    ];
    const haystack = [logs.join("\n"), ...responses.map((response) => response.text)].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(haystack).not.toContain(rawKey);
    expect(haystack).not.toContain(TEST_TOKENS.clerk);
  }, TEST_TIMEOUT_MS);
});

describe("POST /v2/quotes/{quoteId}/cancel", () => {
  it("AB/AD/31: the creator cancels a draft — no number, no operation, one minimal audit event, binding", async () => {
    const harness = await start();
    const draft = await harness.draft();
    const before = await harness.counts();
    const response = await harness.cancel(draft.quoteId, { correlationId: "trace-cancel-1", body: cancelBody(1, { note: "Cliente Pedro desistió" }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotent-replay")).toBeNull();
    expect(Object.keys(response.body).sort()).toEqual(QUOTE_KEYS);
    expect(response.body).toMatchObject({
      quoteId: draft.quoteId,
      status: "cancelled",
      version: 2,
      quoteNumber: null,
      validity: null,
      issuance: null,
      expiration: null,
      cancellation: { reasonCode: "customer_declined", initiatedBy: "clerk", cancelledAt: expect.any(String) },
      document: { available: false }
    });
    expect((await harness.get(`/v2/quotes/${draft.quoteId}`)).body).toEqual(response.body);
    expect(await harness.counts()).toMatchObject({ operations: before.operations, sequence: before.sequence, bindings: before.bindings + 1 });

    const events = await harness.events(draft.quoteId);
    expect(events.at(-1)).toEqual({
      event_type: "quote.cancelled",
      principal_id: "clerk",
      operation_id: null,
      correlation_id: "trace-cancel-1",
      idempotency_key_hash: sha256Hex("cancel-1"),
      from_status: "draft",
      to_status: "cancelled",
      data: { reasonCode: "customer_declined", previousVersion: 1, version: 2, hasNote: true }
    });
    expect(JSON.stringify(events)).not.toContain("Pedro");
    expect((await harness.lookup("quote.cancel", "cancel-1")).body.binding).toMatchObject({ quoteId: draft.quoteId, operationId: null, quoteStatus: "cancelled" });
  }, TEST_TIMEOUT_MS);

  it("AC/14: read:any never grants cancel (404 like a missing quote); scopes and body are checked; nothing is bound", async () => {
    const harness = await start();
    const draft = await harness.draft();
    const before = await harness.counts();
    const unknown = await harness.cancel(UNKNOWN_ID, { token: TEST_TOKENS.backoffice, key: "foreign-unknown" });

    for (const token of [TEST_TOKENS.backoffice, TEST_TOKENS.supervisor, TEST_TOKENS.clerk2]) {
      const foreign = await harness.cancel(draft.quoteId, { token, key: "foreign-cancel" });
      expect(foreign.status).toBe(404);
      expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(unknown.body));
    }
    expect(unknown.body.error.code).toBe("quote_not_found");
    expect((await harness.cancel(draft.quoteId, { token: TEST_TOKENS.sales })).body.error).toMatchObject({
      code: "forbidden",
      details: { requiredScope: "quotes:cancel" }
    });
    expect((await harness.cancel(draft.quoteId, { key: null })).status).toBe(400);
    expect((await harness.cancel(draft.quoteId, { body: { expectedVersion: 1 } })).body.error.code).toBe("validation_error");
    expect((await harness.cancel(draft.quoteId, { body: { ...cancelBody(1), validUntil: "x" } })).body.error.code).toBe("validation_error");
    expect((await harness.cancel(draft.quoteId, { body: cancelBody(7) })).body.error).toMatchObject({
      code: "version_conflict",
      details: { expectedVersion: 7, currentVersion: 1 }
    });
    expect(await harness.counts()).toEqual(before);
    expect((await harness.quoteRow(draft.quoteId)).status).toBe("draft");
  }, TEST_TIMEOUT_MS);

  it("AE/AF/23: issued cancels just before validUntilExclusive; at and after the boundary it is expired", async () => {
    const harness = await start();
    const atBoundary = await harness.issuing();
    const afterBoundary = await harness.issuing();
    const before = await harness.issuing();
    const boundaries = new Map<string, Date>();

    for (const { quoteId } of [atBoundary, afterBoundary, before]) {
      boundaries.set(quoteId, (await harness.markIssued(quoteId)).validUntilExclusive);
    }

    for (const [quote, offset] of [[atBoundary, 0], [afterBoundary, 1]] as const) {
      harness.clock.pinned = plusMs(boundaries.get(quote.quoteId)!, offset);
      const rejected = await harness.cancel(quote.quoteId, { key: `cancel-${offset}`, body: cancelBody(3) });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "expired" } });
      expect(await harness.quoteRow(quote.quoteId)).toMatchObject({ status: "issued", version: 3, cancelled_at: null });
    }

    harness.clock.pinned = plusMs(boundaries.get(before.quoteId)!, -1);
    const manifest = await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [before.quoteId]);
    const cancelled = await harness.cancel(before.quoteId, { key: "cancel-before", body: cancelBody(3) });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      version: 4,
      quoteNumber: before.quoteNumber,
      expiration: null,
      cancellation: { cancelledAt: new Date(harness.clock.pinned.getTime()).toISOString(), initiatedBy: "clerk" },
      document: { available: true }
    });
    // The document is untouched (D-4); the event names the issuance operation.
    expect(await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [before.quoteId])).toEqual(manifest);
    expect((await harness.events(before.quoteId)).at(-1)).toMatchObject({
      event_type: "quote.cancelled",
      operation_id: before.operationId,
      from_status: "issued",
      data: { quoteNumber: before.quoteNumber, previousVersion: 3, version: 4 }
    });
    // Cancelled is terminal: later reads never project expired.
    harness.clock.pinned = plusMs(boundaries.get(before.quoteId)!, 1);
    expect((await harness.get(`/v2/quotes/${before.quoteId}`)).body.status).toBe("cancelled");
  }, TEST_TIMEOUT_MS);

  it("AG/18/19: expired and cancelled are terminal — 409 invalid_state_transition, never expired → cancelled", async () => {
    const harness = await start();
    const expired = await harness.issuing();
    const { validUntilExclusive } = await harness.markIssued(expired.quoteId);
    await harness.sql(`update quote_service.quotes set status = 'expired', expired_at = $2, version = version + 1 where quote_id = $1`, [
      expired.quoteId,
      validUntilExclusive
    ]);
    const response = await harness.cancel(expired.quoteId, { body: cancelBody(4) });
    expect(response.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "expired" } });
    expect((await harness.quoteRow(expired.quoteId)).status).toBe("expired");

    // Already cancelled: the same key replays; a new key is a state conflict; no second event.
    const draft = await harness.draft();
    expect((await harness.cancel(draft.quoteId, { key: "first" })).status).toBe(200);
    const replay = await harness.cancel(draft.quoteId, { key: "first", correlationId: "another-trace" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    const second = await harness.cancel(draft.quoteId, { key: "second", body: cancelBody(2) });
    expect(second.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "cancelled" } });
    expect((await harness.events(draft.quoteId)).filter((event) => event.event_type === "quote.cancelled")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("AH/AI/AJ/AK/17: issuing is cancellable only while its current operation is failed", async () => {
    const harness = await start();
    const { quoteId, operationId, quoteNumber } = await harness.issuing();

    // AH: pending.
    let response = await harness.cancel(quoteId, { key: "c-pending", body: cancelBody(2) });
    expect(response.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId } });

    // AI: running (a passed deadline alone is not failure either).
    await harness.markRunning(operationId);
    await harness.sql(`update quote_service.issuance_operations set lease_expires_at = now() - interval '1 second' where operation_id = $1`, [operationId]);
    response = await harness.cancel(quoteId, { key: "c-running", body: cancelBody(2) });
    expect(response.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId } });

    // AK: after a failure, an operator retry makes an active operation current again.
    await harness.markFailed(operationId);
    const retryId = await harness.operatorRetry(quoteId, operationId);
    response = await harness.cancel(quoteId, { key: "c-retry", body: cancelBody(3) });
    expect(response.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId: retryId } });
    expect(await harness.sql(`select count(*)::int as bound from quote_service.idempotency_bindings where operation = 'quote.cancel'`)).toEqual([{ bound: 0 }]);

    // AJ: current operation failed → the creator may cancel; number kept, no document, op stays failed.
    await harness.markFailed(retryId);
    expect((await harness.cancel(quoteId, { key: "c-failed", token: TEST_TOKENS.backoffice, body: cancelBody(3) })).status).toBe(404);
    response = await harness.cancel(quoteId, { key: "c-failed", body: cancelBody(3) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "cancelled", version: 4, quoteNumber, issuance: { operationId: retryId }, document: { available: false } });
    expect(await harness.sql(`select status from quote_service.issuance_operations where quote_id = $1 order by accepted_at, operation_id`, [quoteId])).toEqual([
      { status: "failed" },
      { status: "failed" }
    ]);
    expect((await harness.events(quoteId)).at(-1)).toMatchObject({
      event_type: "quote.cancelled",
      operation_id: retryId,
      from_status: "issuing",
      data: { operationStatus: "failed", quoteNumber }
    });
  }, TEST_TIMEOUT_MS);

  it("AL/AM/20: same key replays one effect; a changed body conflicts; key scope is per principal", async () => {
    const harness = await start();
    const draft = await harness.draft();
    const first = await harness.cancel(draft.quoteId, { correlationId: "trace-a" });
    const replay = await harness.cancel(draft.quoteId, { correlationId: "trace-b" });

    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body).toEqual(first.body);

    const conflict = await harness.cancel(draft.quoteId, { body: cancelBody(1, { reasonCode: "duplicate_request" }) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: "idempotency_key_conflict",
      details: {
        operation: "quote.cancel",
        boundRequestFingerprint: sha256Jcs({ operation: "quote.cancel", pathParameters: { quoteId: draft.quoteId }, body: cancelBody(1) })
      }
    });
    expect((await harness.events(draft.quoteId)).map((event) => event.event_type)).toEqual([
      "quote.draft.created",
      "quote.cancelled",
      "idempotency.replayed",
      "idempotency.conflict"
    ]);

    // Another principal's identical key value is an independent scope.
    const other = await harness.draft({ token: TEST_TOKENS.clerk2 });
    expect((await harness.cancel(other.quoteId, { token: TEST_TOKENS.clerk2 })).status).toBe(200);
  }, TEST_TIMEOUT_MS);
});

describe("cancel — concurrency (real PostgreSQL)", () => {
  async function cancelledEventsPerQuote(harness: Harness) {
    return harness.sql<{ quote_id: string; events: number }>(
      `select quote_id, count(*)::int as events from quote_service.quote_audit_events
       where event_type = 'quote.cancelled' group by quote_id having count(*) > 1`
    );
  }

  it("AN/AO/AR: concurrent same-key cancels converge on one effect; different keys serialize to one winner", async () => {
    const harness = await start();
    const same = await harness.draft();
    // The first holds the per-scope lock and queues on the row; the rest queue on the scope lock.
    const sameResponses = await harness.raceOnRowLock(
      same.quoteId,
      Array.from({ length: 6 }, () => () => harness.cancel(same.quoteId, { key: "same-key" }))
    );

    expect(sameResponses.map((response) => response.status)).toEqual(Array(6).fill(200));
    expect(sameResponses.map((response) => response.headers.get("idempotent-replay"))).toEqual([null, "true", "true", "true", "true", "true"]);
    expect(new Set(sameResponses.map((response) => response.text)).size).toBe(1);

    const different = await harness.draft();
    const differentResponses = await harness.raceOnRowLock(
      different.quoteId,
      Array.from({ length: 6 }, (_, index) => () => harness.cancel(different.quoteId, { key: `key-${index}` }))
    );
    // Lock queue order is launch order: the first wins, every later command sees `cancelled`.
    expect(differentResponses.map((response) => response.status)).toEqual([200, 409, 409, 409, 409, 409]);
    for (const response of differentResponses.slice(1)) {
      expect(response.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "cancelled" } });
    }

    expect(await cancelledEventsPerQuote(harness)).toEqual([]);
    expect(await harness.sql(`select count(*)::int as bound from quote_service.idempotency_bindings where operation = 'quote.cancel'`)).toEqual([{ bound: 2 }]);
  }, TEST_TIMEOUT_MS);

  it("AP/22: issue vs cancel of the same draft — exactly one valid history, never cancelled with a pending operation", async () => {
    const harness = await start();
    const outcomes: string[] = [];

    for (let round = 0; round < 6; round += 1) {
      const draft = await harness.draft();
      const issue = () => harness.issue(draft.quoteId, { key: `race-issue-${round}` });
      const cancel = () => harness.cancel(draft.quoteId, { key: `race-cancel-${round}` });
      // Both are in flight on the same row; alternate which one queues first.
      const issueFirst = round % 2 === 0;
      const responses = await harness.raceOnRowLock(draft.quoteId, issueFirst ? [issue, cancel] : [cancel, issue]);
      const [issued, cancelled] = issueFirst ? responses : [responses[1], responses[0]];
      const row = await harness.quoteRow(draft.quoteId);

      if (issued!.status === 202) {
        expect(cancelled!.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId: issued!.body.operation.operationId } });
        expect(row).toMatchObject({ status: "issuing", cancelled_at: null });
        outcomes.push("issue");
      } else {
        expect(cancelled!.status).toBe(200);
        expect(issued!.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "cancelled" } });
        expect(row).toMatchObject({ status: "cancelled", quote_number: null, current_operation_id: null });
        outcomes.push("cancel");
      }
    }

    // Both valid histories occurred, each decided by who held the row first.
    expect(outcomes).toEqual(["issue", "cancel", "issue", "cancel", "issue", "cancel"]);
    expect(
      await harness.sql(
        `select q.quote_id from quote_service.quotes q join quote_service.issuance_operations o on o.quote_id = q.quote_id
         where q.status = 'cancelled' and o.status in ('pending', 'running')`
      )
    ).toEqual([]);
    expect(await cancelledEventsPerQuote(harness)).toEqual([]);
  }, 2 * TEST_TIMEOUT_MS);

  it("AQ: edit vs cancel from the same version — one wins, the other is a stable 409, no lost update", async () => {
    const harness = await start();

    const outcomes: string[] = [];

    for (let round = 0; round < 6; round += 1) {
      const draft = await harness.draft();
      const body = { expectedVersion: 1, lines: draftBody().lines.slice(0, 1) };
      const edit = () => harness.updateDraft(draft.quoteId, { key: `race-edit-${round}`, body });
      const cancel = () => harness.cancel(draft.quoteId, { key: `race-cancel-${round}` });
      const editFirst = round % 2 === 0;
      const responses = await harness.raceOnRowLock(draft.quoteId, editFirst ? [edit, cancel] : [cancel, edit]);
      const [edited, cancelled] = editFirst ? responses : [responses[1], responses[0]];
      const row = await harness.quoteRow(draft.quoteId);
      const lines = await harness.sql(`select count(*)::int as lines from quote_service.quote_lines where quote_id = $1`, [draft.quoteId]);

      if (edited!.status === 200) {
        expect(cancelled!.body.error).toMatchObject({ code: "version_conflict", details: { expectedVersion: 1, currentVersion: 2 } });
        expect(row).toMatchObject({ status: "draft", version: 2 });
        expect(lines).toEqual([{ lines: 1 }]);
        outcomes.push("edit");
      } else {
        expect(cancelled!.status).toBe(200);
        expect(edited!.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "cancelled" } });
        expect(row).toMatchObject({ status: "cancelled", version: 2 });
        expect(lines).toEqual([{ lines: draftBody().lines.length }]);
        outcomes.push("cancel");
      }
    }

    expect(outcomes).toEqual(["edit", "cancel", "edit", "cancel", "edit", "cancel"]);
    expect(await cancelledEventsPerQuote(harness)).toEqual([]);
  }, 2 * TEST_TIMEOUT_MS);

  it("23: a cancel queued on the row lock while the boundary passes is evaluated when it holds the lock → expired", async () => {
    const harness = await start();
    const { quoteId } = await harness.issuing();
    const { validUntilExclusive: boundary } = await harness.markIssued(quoteId);

    // The request arrives (and its transaction starts) before the boundary...
    harness.clock.pinned = plusMs(boundary, -1);
    const [late] = await harness.raceOnRowLock(
      quoteId,
      [() => harness.cancel(quoteId, { body: cancelBody(3) })],
      // ...and the boundary passes while it waits behind another transaction.
      () => {
        harness.clock.pinned = boundary;
      }
    );

    expect(late!.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "expired" } });
    expect(await harness.quoteRow(quoteId)).toMatchObject({ status: "issued", cancelled_at: null });
    expect((await harness.get(`/v2/quotes/${quoteId}`)).body.status).toBe("expired");
  }, TEST_TIMEOUT_MS);
});

describe("migrated V1 quotes (R1.4 data)", () => {
  it("25: legacy quotes read with preserved numbers, legacy validity, synthetic operation, manifest and projection", async () => {
    const harness = await start({ legacy: true });
    const read = async (id: string) => (await harness.get(`/v2/quotes/${id}`, TEST_TOKENS.backoffice)).body;

    // Legacy validity in the past: the stored issued quote projects expired at its recorded boundary.
    const issued = await read(V1_IDS.issued);
    expect(issued).toMatchObject({
      status: "expired",
      quoteNumber: "PC-000002",
      createdByPrincipalId: "legacy-v1",
      validity: { source: "legacy_caller_supplied", policyId: null, tzdbVersion: null, validUntilExclusive: "2026-03-15T03:00:00Z" },
      expiration: { expiredAt: "2026-03-15T03:00:00Z" },
      document: { available: true, byteLength: null, templateVersion: "v1-legacy" }
    });
    expect(Object.keys(issued).sort()).toEqual(QUOTE_KEYS);
    const operation = await harness.get(`/v2/operations/${issued.issuance.operationId}`, TEST_TOKENS.backoffice);
    expect(operation.body).toMatchObject({ quoteId: V1_IDS.issued, status: "succeeded", attempts: { count: 0 } });

    // Before the boundary (injected clock) the same row reads issued.
    harness.clock.pinned = new Date("2026-03-12T00:00:00Z");
    expect(await read(V1_IDS.issued)).toMatchObject({ status: "issued", expiration: null });
    // accepted / paid are never V2 states.
    expect((await read(V1_IDS.accepted)).status).toBe("issued");
    expect((await read(V1_IDS.paid)).status).toBe("issued");
    harness.clock.pinned = null;

    // A materialized V1 expiry keeps its recorded instant (validity V-6 exception).
    expect(await read(V1_IDS.expired)).toMatchObject({ status: "expired", expiration: { expiredAt: "2026-03-15T03:00:05Z" } });
    expect(await read(V1_IDS.cancelledIssued)).toMatchObject({
      status: "cancelled",
      quoteNumber: "PC-000005",
      cancellation: { initiatedBy: "legacy-v1", reasonCode: "legacy_v1" },
      document: { available: true }
    });
    expect(await read(V1_IDS.cancelledDraft)).toMatchObject({ status: "cancelled", quoteNumber: null, document: { available: false } });

    // Lists and audit work; legacy evidence never leaks.
    const listed = await harness.get(
      "/v2/quotes?sourceSystem=crm_customer_360&externalReferenceType=opportunity&externalReference=opp-crm-002",
      TEST_TOKENS.backoffice
    );
    expect(listed.body.items.map((item: AnyRecord) => item.quoteId).sort()).toEqual([V1_IDS.issued, V1_IDS.revision].sort());
    const audit = await harness.get(`/v2/quotes/${V1_IDS.issued}/audit`, TEST_TOKENS.backoffice);
    expect(audit.status).toBe(200);
    expect(new Set(audit.body.items.map((event: AnyRecord) => event.type))).toEqual(new Set(["legacy.v1.event"]));
    const texts = [listed.text, audit.text, JSON.stringify(issued)].join("\n");
    for (const internal of ["quote_legacy_v1", "v1Status", "sourceCorrelationId", "storageKey", "conversationId", "revisionRootId"]) {
      expect(texts).not.toContain(internal);
    }

    // Visibility and A4 still apply: no read:any → 404; read:any cannot cancel a legacy quote.
    expect((await harness.get(`/v2/quotes/${V1_IDS.issued}`, TEST_TOKENS.clerk)).status).toBe(404);
    harness.clock.pinned = new Date("2026-03-12T00:00:00Z");
    expect((await harness.cancel(V1_IDS.issued, { token: TEST_TOKENS.backoffice, body: cancelBody(2) })).body.error.code).toBe("quote_not_found");
  }, TEST_TIMEOUT_MS);
});

describe("read surface — readiness", () => {
  it("29/30: business reads fail closed with schema_not_ready / dependency_unavailable", async () => {
    const unmigrated = await start({ migrate: false });
    for (const pathname of [`/v2/quotes/${UNKNOWN_ID}`, "/v2/quotes?sourceSystem=x", `/v2/operations/${UNKNOWN_ID}`]) {
      const response = await unmigrated.get(pathname);
      expect([pathname, response.status, response.body.error.code]).toEqual([pathname, 503, "schema_not_ready"]);
    }

    const down = await start({ databaseUrl: "postgres://postgres:postgres@127.0.0.1:1/postgres" });
    const response = await down.get(`/v2/quotes/${UNKNOWN_ID}/audit`);
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "database" } });
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres:/);
  }, TEST_TIMEOUT_MS);
});
