/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import { isVisible } from "../../src/application/auth/principal";
import { resolveValidity } from "../../src/application/quote-v2/validity";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { r15aSemanticSnapshotHash } from "../helpers/r15a-snapshot-hash";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS as SHARED_TOKENS, testRegistryDocument } from "../helpers/test-principals";

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Response = { status: number; body: AnyRecord; text: string; headers: Headers };

const TEST_TIMEOUT_MS = 60_000;
const TEST_TOKENS = { ...SHARED_TOKENS, clerk: "test-draft-clerk-own-quotes-token-0123456789abcdefghijk" };

/** Shared test registry plus a draft writer limited to its own quotes (no quotes:read:any). */
function registry(): PrincipalRegistry {
  const document = testRegistryDocument();
  document.principals.push({
    principalId: "clerk",
    principalType: "operator",
    scopes: ["quotes:draft:write", "quotes:issue", "quotes:read"],
    tokenSha256: [sha256Hex(TEST_TOKENS.clerk)]
  });
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
/** Frozen manual-flow chain: draft (v1) → update to 15 m (v2) → issue v2 with the example's expectedTotals. */
const draftRequest = () => example("draft-create.request.json");
const updateRequest = () => example("draft-update.request.json");
const issueRequest = () => example("issue.request.json");
const shippingInput = () => example("shipping.input.json");

const DRAFT_TOTALS = example("draft-create.response-201.json").totals;
const ISSUED_TOTALS = example("issue.response-200.json").quote.totals;

interface CallOptions {
  token?: string;
  key?: string | null;
  correlationId?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function start(options: { migrate?: boolean; databaseUrl?: string; beforeListen?: (context: ApplicationContext) => void } = {}) {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());

  if (options.migrate ?? true) {
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  }

  const holder: { context?: ApplicationContext } = {};
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-v2-drafts-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const context = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: options.databaseUrl ?? database.connectionString,
      storageRoot,
      overrides: { LOG_LEVEL: "silent" }
    }),
    {
      principalRegistry: registry(),
      // Acceptance-only suite: quotes must stay `issuing` (issuance execution is covered in issuance-commit tests).
      disableIssuanceExecution: true,
      // Test-only read probe (the public read routes arrive in A.4) applying the production visibility rule.
      businessRoutes: [
        (app) =>
          app.get("/probe/quotes/:quoteId", { config: { requiredScope: "quotes:read" } }, async (request, reply) => {
            const { rows } = await holder.context!.database.query<{ created_by_principal_id: string }>(
              "select created_by_principal_id from quote_service.quotes where quote_id = $1",
              [(request.params as { quoteId: string }).quoteId]
            );
            const visible = rows[0] !== undefined && isVisible(request.principal!, rows[0].created_by_principal_id);
            return reply.code(visible ? 200 : 404).send({ visible });
          })
      ]
    }
  );
  holder.context = context;
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  options.beforeListen?.(context);
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());

  async function call(method: string, pathname: string, { token = TEST_TOKENS.backoffice, key = "key-1", correlationId, body, signal }: CallOptions): Promise<Response> {
    const headers: Record<string, string> = { Authorization: bearer(token), "Content-Type": "application/json" };

    if (key !== null) {
      headers["Idempotency-Key"] = key;
    }

    if (correlationId !== undefined) {
      headers["X-Correlation-Id"] = correlationId;
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, text, headers: response.headers };
  }

  const harness = {
    context,
    sql: async <T extends pg.QueryResultRow = AnyRecord>(text: string, values: unknown[] = []) => (await admin.query<T>(text, values)).rows,
    createDraft: (options: CallOptions = {}) => call("POST", "/v2/quotes/drafts", { key: "draft-1", body: draftRequest(), ...options }),
    updateDraft: (quoteId: string, options: CallOptions = {}) =>
      call("PATCH", `/v2/quotes/${quoteId}/draft`, { key: "update-1", body: updateRequest(), ...options }),
    issue: (quoteId: string, options: CallOptions = {}) => call("POST", `/v2/quotes/${quoteId}/issue`, { key: "issue-1", body: issueRequest(), ...options }),
    read: (quoteId: string, token: string) => call("GET", `/probe/quotes/${quoteId}`, { token, key: null }),
    createAndIssue: (options: CallOptions = {}) =>
      call("POST", "/v2/quotes", { token: TEST_TOKENS.sales, key: "create-1", body: example("create-and-issue.request.json"), ...options }),
    /** Durable footprint, used to prove "no effect". */
    async footprint() {
      const [counts] = await harness.sql(
        `select (select count(*)::int from quote_service.quotes) as quotes,
                (select count(*)::int from quote_service.quote_lines) as lines,
                (select count(*)::int from quote_service.quote_shipping) as shipping,
                (select count(*)::int from quote_service.issuance_operations) as operations,
                (select count(*)::int from quote_service.idempotency_bindings) as bindings,
                (select count(*)::int from quote_service.quote_documents) as documents,
                (select count(*)::int from quote_service.quote_deliveries) as deliveries,
                (select last_value::text || ':' || is_called::text from quote_service.quote_number_seq) as sequence`
      );
      return counts!;
    },
    async quoteRow(quoteId: string) {
      return (await harness.sql(`select *, validity_through_local_date::text as through from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    async events(quoteId: string) {
      return harness.sql(
        `select event_type, principal_id, operation_id, correlation_id, idempotency_key_hash, from_status, to_status, data
         from quote_service.quote_audit_events where quote_id = $1 order by sequence`,
        [quoteId]
      );
    }
  };
  return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

/** draft v1 → update v2, the state the frozen issue example expects. */
async function editedDraft(harness: Harness, suffix = "", token: string = TEST_TOKENS.backoffice): Promise<string> {
  const created = await harness.createDraft({ token, key: `draft-1${suffix}` });
  expect(created.status).toBe(201);
  const updated = await harness.updateDraft(created.body.quoteId, { token, key: `update-1${suffix}` });
  expect(updated.status).toBe(200);
  return created.body.quoteId as string;
}

describe("POST /v2/quotes/drafts", () => {
  it("A–E: creates an editable draft with owner totals and no number, validity, operation or document", async () => {
    const harness = await start();
    const response = await harness.createDraft({ correlationId: "trace-draft-1" });
    const quote = response.body;

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`/v2/quotes/${quote.quoteId}`);
    expect(response.headers.get("idempotent-replay")).toBeNull();
    expect(Object.keys(quote).sort()).toEqual(Object.keys(example("draft-create.response-201.json")).sort());
    expect(quote).toMatchObject({
      status: "draft",
      version: 1,
      quoteNumber: null,
      validity: null,
      issuance: null,
      cancellation: null,
      expiration: null,
      shipping: null,
      createdByPrincipalId: "backoffice",
      externalCorrelation: draftRequest().externalCorrelation,
      customer: draftRequest().customer,
      document: { available: false, pdfSha256: null }
    });
    // E: exact owner arithmetic (frozen example).
    expect(quote.totals).toEqual(DRAFT_TOTALS);
    expect(quote.lines.map((line: AnyRecord) => line.amounts)).toEqual(
      example("draft-create.response-201.json").lines.map((line: AnyRecord) => line.amounts)
    );

    const row = await harness.quoteRow(quote.quoteId);
    expect(row).toMatchObject({ status: "draft", quote_number: null, issued_at: null, current_operation_id: null, validity_source: null });
    expect(row.valid_until_exclusive).toBeNull();
    expect(await harness.footprint()).toMatchObject({ quotes: 1, lines: 2, operations: 0, documents: 0, deliveries: 0, bindings: 1, sequence: "1:false" });

    const events = await harness.events(quote.quoteId);
    expect(events).toEqual([
      {
        event_type: "quote.draft.created",
        principal_id: "backoffice",
        operation_id: null,
        correlation_id: "trace-draft-1",
        idempotency_key_hash: sha256Hex("draft-1"),
        from_status: null,
        to_status: "draft",
        data: { version: 1, lineCount: 2, hasShipping: false, gross: DRAFT_TOTALS.gross, externalReferenceType: "case", externalReference: "CASE-2026-0912" }
      }
    ]);
  }, TEST_TIMEOUT_MS);

  it("F: structured shipping is stored as given with owner-computed amounts; zero-line drafts are allowed", async () => {
    const harness = await start();
    const withShipping = await harness.createDraft({ body: { ...draftRequest(), shipping: shippingInput() } });

    expect(withShipping.status).toBe(201);
    expect(withShipping.body.shipping).toMatchObject({ ...shippingInput(), amounts: { net: 5990, tax: 1138, gross: 7128 } });
    expect(withShipping.body.totals.gross).toBe(DRAFT_TOTALS.gross + 7128);

    const empty = await harness.createDraft({ key: "draft-empty", body: { ...draftRequest(), lines: [] } });
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ lines: [], totals: { net: 0, tax: 0, gross: 0, exemptNet: 0 } });
  }, TEST_TIMEOUT_MS);

  it("rejects members the frozen CreateDraftRequest does not declare (expectedTotals, validityOverride) with nothing written", async () => {
    const harness = await start();
    const totals = await harness.createDraft({ body: { ...draftRequest(), expectedTotals: { net: 1, tax: 1, gross: 2 } } });
    const override = await harness.createDraft({ body: { ...draftRequest(), validityOverride: { validThroughLocalDate: "2026-12-31", reasonCode: "x_y" } } });

    for (const response of [totals, override]) {
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("validation_error");
    }

    expect(await harness.footprint()).toMatchObject({ quotes: 0, bindings: 0 });
  }, TEST_TIMEOUT_MS);

  it("G/H/I: same key replays the same draft (even with another X-Correlation-Id); a changed request conflicts", async () => {
    const harness = await start();
    const first = await harness.createDraft({ correlationId: "a" });
    const replay = await harness.createDraft({ correlationId: "b" });

    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body).toEqual(first.body);

    const changed = await harness.createDraft({ body: { ...draftRequest(), lines: [] } });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: "idempotency_key_conflict", details: { operation: "quote.draft.create" } });
    expect(await harness.footprint()).toMatchObject({ quotes: 1, bindings: 1 });
    expect((await harness.events(first.body.quoteId)).map((event) => event.event_type)).toEqual([
      "quote.draft.created",
      "idempotency.replayed",
      "idempotency.conflict"
    ]);
  }, TEST_TIMEOUT_MS);

  it("J: the same raw key under different principals creates independent drafts", async () => {
    const harness = await start();
    const backoffice = await harness.createDraft();
    const supervisor = await harness.createDraft({ token: TEST_TOKENS.supervisor });

    expect(supervisor.status).toBe(201);
    expect(supervisor.headers.get("idempotent-replay")).toBeNull();
    expect(supervisor.body.quoteId).not.toBe(backoffice.body.quoteId);
    expect(supervisor.body.createdByPrincipalId).toBe("supervisor");
  }, TEST_TIMEOUT_MS);

  it("K: concurrent same-key creates converge on one draft; same key with different bodies → one draft, one conflict", async () => {
    const harness = await start();
    const same = await Promise.all(Array.from({ length: 6 }, () => harness.createDraft({ key: "race" })));

    expect(same.map((response) => response.status)).toEqual(Array(6).fill(201));
    expect(same.filter((response) => response.headers.get("idempotent-replay") === null)).toHaveLength(1);
    expect(new Set(same.map((response) => response.body.quoteId)).size).toBe(1);

    const mixed = await Promise.all([
      harness.createDraft({ key: "race-2" }),
      harness.createDraft({ key: "race-2", body: { ...draftRequest(), lines: [] } })
    ]);
    expect(mixed.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await harness.footprint()).toMatchObject({ quotes: 2, bindings: 2 });
  }, TEST_TIMEOUT_MS);

  it("needs quotes:draft:write (403 before any binding) and is readiness-gated (503)", async () => {
    const harness = await start();
    const forbidden = await harness.createDraft({ token: TEST_TOKENS.sales });

    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: "forbidden", details: { requiredScope: "quotes:draft:write" } });
    expect((await harness.createDraft({ token: "not-a-registered-token-0123456789abcdef" })).status).toBe(401);
    expect((await harness.createDraft({ key: null })).body.error.code).toBe("invalid_request");
    expect(await harness.footprint()).toMatchObject({ quotes: 0, bindings: 0 });

    const down = await start({ databaseUrl: "postgres://quote:quote@127.0.0.1:1/quote" });
    expect((await down.createDraft()).body.error.code).toBe("dependency_unavailable");
    const unmigrated = await start({ migrate: false });
    expect((await unmigrated.createDraft()).body.error.code).toBe("schema_not_ready");
  }, TEST_TIMEOUT_MS);
});

describe("PATCH /v2/quotes/{quoteId}/draft", () => {
  it("L/Q: replaces members, recomputes totals and increments the version exactly once", async () => {
    const harness = await start();
    const created = await harness.createDraft({ body: { ...draftRequest(), shipping: shippingInput() } });
    const updated = await harness.updateDraft(created.body.quoteId, { correlationId: "trace-edit" });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ quoteId: created.body.quoteId, status: "draft", version: 2, quoteNumber: null, validity: null });
    expect(updated.body.lines[0].quantity.value).toBe("15");
    // Omitted members are unchanged: shipping and customer survive a lines-only patch.
    expect(updated.body.shipping).toEqual(created.body.shipping);
    expect(updated.body.customer).toEqual(created.body.customer);
    expect(updated.body.totals).toEqual({ ...ISSUED_TOTALS, net: ISSUED_TOTALS.net + 5990, tax: ISSUED_TOTALS.tax + 1138, gross: ISSUED_TOTALS.gross + 7128 });

    // shipping: null removes; customer replaced whole.
    const customer = example("customer.guest.json");
    const removed = await harness.updateDraft(created.body.quoteId, { key: "update-2", body: { expectedVersion: 2, shipping: null, customer } });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ version: 3, shipping: null, customer, totals: ISSUED_TOTALS });
    expect(await harness.footprint()).toMatchObject({ lines: 2, shipping: 0, operations: 0, sequence: "1:false" });

    const updates = (await harness.events(created.body.quoteId)).filter((event) => event.event_type === "quote.draft.updated");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ from_status: "draft", to_status: "draft", correlation_id: "trace-edit", data: { version: 2, previousVersion: 1, replacedMembers: ["lines"] } });
    expect(updates[1]!.data).toMatchObject({ version: 3, previousVersion: 2, replacedMembers: ["customer", "shipping"] });
  }, TEST_TIMEOUT_MS);

  it("M: a stale expectedVersion → 409 version_conflict and nothing changes", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const before = await harness.quoteRow(quoteId);
    const stale = await harness.updateDraft(quoteId, { key: "update-stale" });

    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "version_conflict", details: { expectedVersion: 1, currentVersion: 2 } });
    expect(await harness.quoteRow(quoteId)).toEqual(before);
    expect(await harness.footprint()).toMatchObject({ bindings: 2 });
  }, TEST_TIMEOUT_MS);

  it("N/O: a replay returns the current draft without a second increment; a changed patch under the key conflicts", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const replay = await harness.updateDraft(quoteId, { correlationId: "other-trace" });

    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.version).toBe(2);

    const changed = await harness.updateDraft(quoteId, { body: { ...updateRequest(), lines: [] } });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatchObject({ code: "idempotency_key_conflict", details: { operation: "quote.draft.update" } });
    expect((await harness.quoteRow(quoteId)).version).toBe(2);
    expect((await harness.events(quoteId)).filter((event) => event.event_type === "quote.draft.updated")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("P/A4: only the creator may edit or issue; quotes:read:any grants reads, never mutation, and hides existence", async () => {
    const harness = await start();
    // supervisor and backoffice both hold quotes:read:any (plus draft:write and issue); clerk does not.
    const created = await harness.createDraft({ token: TEST_TOKENS.supervisor });
    const quoteId = created.body.quoteId;
    const before = await harness.quoteRow(quoteId);
    const footprint = await harness.footprint();
    const strip = (response: Response) => ({ status: response.status, code: response.body.error.code, message: response.body.error.message, details: response.body.error.details });
    const MISSING = "00000000-0000-4000-8000-000000000000";
    const notFound = { status: 404, code: "quote_not_found", message: "Quote not found.", details: undefined };

    // Another principal WITH quotes:read:any cannot edit or issue: same 404 as a missing quote.
    const anyEdit = await harness.updateDraft(quoteId, { token: TEST_TOKENS.backoffice, key: "any-edit" });
    const anyIssue = await harness.issue(quoteId, { token: TEST_TOKENS.backoffice, key: "any-issue", body: { expectedVersion: 1 } });
    expect(strip(anyEdit)).toEqual(notFound);
    expect(strip(anyIssue)).toEqual(notFound);
    expect(strip(await harness.updateDraft(MISSING, { token: TEST_TOKENS.backoffice, key: "any-missing" }))).toEqual(notFound);

    // Another principal WITHOUT read:any: identical answers.
    expect(strip(await harness.updateDraft(quoteId, { token: TEST_TOKENS.clerk, key: "clerk-edit" }))).toEqual(notFound);
    expect(strip(await harness.issue(quoteId, { token: TEST_TOKENS.clerk, key: "clerk-issue", body: { expectedVersion: 1 } }))).toEqual(notFound);
    expect(strip(await harness.issue(MISSING, { token: TEST_TOKENS.clerk, key: "clerk-missing", body: { expectedVersion: 1 } }))).toEqual(notFound);

    // Nothing changed, nothing was bound or numbered.
    expect(await harness.quoteRow(quoteId)).toEqual(before);
    expect(await harness.footprint()).toEqual(footprint);

    // read:any remains usable for reads (A.4 read routes use the same isVisible rule).
    expect((await harness.read(quoteId, TEST_TOKENS.backoffice)).status).toBe(200);
    expect((await harness.read(quoteId, TEST_TOKENS.clerk)).status).toBe(404);

    // The owner, with the required scopes, can edit and then issue.
    const ownerEdit = await harness.updateDraft(quoteId, { token: TEST_TOKENS.supervisor, key: "owner-edit" });
    expect(ownerEdit.status).toBe(200);
    expect(ownerEdit.body).toMatchObject({ version: 2, createdByPrincipalId: "supervisor" });
    const ownerIssue = await harness.issue(quoteId, { token: TEST_TOKENS.supervisor, key: "owner-issue" });
    expect(ownerIssue.status).toBe(202);
    expect(ownerIssue.body.quote).toMatchObject({ quoteId, status: "issuing", totals: ISSUED_TOTALS });

    // Still hidden from read:any for mutation after issue (no state leak through 409s).
    expect(strip(await harness.issue(quoteId, { token: TEST_TOKENS.backoffice, key: "any-issue-2", body: { expectedVersion: 3 } }))).toEqual(notFound);
    expect((await harness.read(quoteId, TEST_TOKENS.backoffice)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("R: a rejected patch (semantic 422) leaves the draft, its lines and version untouched", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const before = await harness.quoteRow(quoteId);
    const lines = await harness.sql(`select * from quote_service.quote_lines where quote_id = $1 order by position`, [quoteId]);
    // The frozen UpdateDraftRequest has no expectedTotals; its arithmetic-side rejection is a charge that cannot be computed.
    const exemptWithRate = { ...updateRequest().lines[1], unitPrice: { amount: 35000, taxBasis: "exempt", taxRate: "0.19" } };
    const response = await harness.updateDraft(quoteId, { key: "update-bad", body: { expectedVersion: 2, lines: [exemptWithRate] } });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({ code: "validation_error", details: { fields: [{ path: "/lines/0/unitPrice/taxRate", code: "forbidden" }] } });
    expect(await harness.quoteRow(quoteId)).toEqual(before);
    expect(await harness.sql(`select * from quote_service.quote_lines where quote_id = $1 order by position`, [quoteId])).toEqual(lines);
    expect(await harness.footprint()).toMatchObject({ bindings: 2 });
  }, TEST_TIMEOUT_MS);

  it("validates the patch shape: expectedVersion required, at least one member, closed schema", async () => {
    const harness = await start();
    const quoteId = (await harness.createDraft()).body.quoteId;

    for (const body of [{ lines: [] }, { expectedVersion: 1 }, { expectedVersion: 1, notes: "x" }, { expectedVersion: 0, lines: [] }]) {
      const response = await harness.updateDraft(quoteId, { key: `bad-${JSON.stringify(body)}`, body });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("validation_error");
    }

    expect((await harness.updateDraft("not-a-uuid")).body.error.code).toBe("invalid_request");
    expect((await harness.updateDraft(quoteId, { token: TEST_TOKENS.sales })).status).toBe(403);
    expect((await harness.quoteRow(quoteId)).version).toBe(1);
  }, TEST_TIMEOUT_MS);
});

describe("POST /v2/quotes/{quoteId}/issue", () => {
  it("T/U/V/AD: issues the exact draft under the same quoteId: number, frozen validity, one pending operation, no document", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const draftBefore = await harness.quoteRow(quoteId);
    const response = await harness.issue(quoteId, { correlationId: "trace-issue" });
    const { quote, operation } = response.body;

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/v2/operations/${operation.operationId}`);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Object.keys(operation).sort()).toEqual(Object.keys(example("issue.response-200.json").operation).sort());
    expect(quote).toMatchObject({ quoteId, status: "issuing", version: 3, quoteNumber: "PC-000001", totals: ISSUED_TOTALS });
    expect(quote.issuance).toEqual({ issuedAt: expect.any(String) as string, operationId: operation.operationId, issuerProfileId: "pesaschile-cl-v1" });
    expect(operation).toMatchObject({ type: "quote.issue", status: "pending", quoteId, completedAt: null, attempts: { count: 0, lastErrorCode: null } });
    expect(quote.document.available).toBe(false);

    // V: validity frozen at the issue instant by the A.2 engine.
    expect(quote.validity).toEqual(resolveValidity(Date.parse(quote.issuance.issuedAt)));
    expect(quote.validity).toMatchObject({ source: "policy", policyId: "cl-retail-5-calendar-days-v1", issuerZone: "America/Santiago" });

    // The commercial snapshot is the draft's, untouched; a single quote row.
    const row = await harness.quoteRow(quoteId);
    expect(row).toMatchObject({ customer: draftBefore.customer, net_amount: draftBefore.net_amount, gross_amount: draftBefore.gross_amount, created_at: draftBefore.created_at });
    expect(await harness.footprint()).toEqual({ quotes: 1, lines: 2, shipping: 0, operations: 1, bindings: 3, documents: 0, deliveries: 0, sequence: "1:true" });

    const [op] = await harness.sql(`select status, generation, origin, snapshot_hash from quote_service.issuance_operations`);
    expect(op).toEqual({ status: "pending", generation: "0", origin: "acceptance", snapshot_hash: r15aSemanticSnapshotHash(quote) });

    const accepted = (await harness.events(quoteId)).find((event) => event.event_type === "quote.issue.accepted")!;
    expect(accepted).toMatchObject({
      principal_id: "backoffice",
      operation_id: operation.operationId,
      correlation_id: "trace-issue",
      idempotency_key_hash: sha256Hex("issue-1"),
      from_status: "draft",
      to_status: "issuing",
      data: {
        quoteNumber: "PC-000001",
        version: 3,
        issuedDraftVersion: 2,
        validitySource: "policy",
        validityPolicyId: "cl-retail-5-calendar-days-v1",
        validThroughLocalDate: quote.validity.validThroughLocalDate,
        validUntilExclusive: quote.validity.validUntilExclusive
      }
    });
  }, TEST_TIMEOUT_MS);

  it("S/DB: once issuing, the commercial snapshot cannot be edited (API) nor updated/deleted (database guards)", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const { operation } = (await harness.issue(quoteId)).body;

    const edit = await harness.updateDraft(quoteId, { key: "after-issue", body: { ...updateRequest(), expectedVersion: 3 } });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId: operation.operationId } });

    await expect(harness.sql(`update quote_service.quote_lines set quantity = 1 where quote_id = $1`, [quoteId])).rejects.toThrow(/not allowed: quote is issuing/);
    await expect(harness.sql(`delete from quote_service.quote_lines where quote_id = $1`, [quoteId])).rejects.toThrow(/not allowed/);
    await expect(harness.sql(`update quote_service.quotes set gross_amount = gross_amount + 1, net_amount = net_amount + 1 where quote_id = $1`, [quoteId])).rejects.toThrow(
      /snapshot is immutable/
    );
    await expect(harness.sql(`update quote_service.quotes set status = 'draft' where quote_id = $1`, [quoteId])).rejects.toThrow(/invalid quote status transition/);
  }, TEST_TIMEOUT_MS);

  it("W: expectedTotals that differ from the owner arithmetic → 422 arithmetic_mismatch, no transition, number or operation", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const response = await harness.issue(quoteId, { body: { ...issueRequest(), expectedTotals: { net: ISSUED_TOTALS.net, tax: ISSUED_TOTALS.tax, gross: 1 } } });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "arithmetic_mismatch",
      details: { computed: { net: ISSUED_TOTALS.net, tax: ISSUED_TOTALS.tax, gross: ISSUED_TOTALS.gross } }
    });
    expect(await harness.quoteRow(quoteId)).toMatchObject({ status: "draft", version: 2, quote_number: null });
    expect(await harness.footprint()).toMatchObject({ operations: 0, bindings: 2, sequence: "1:false" });
  }, TEST_TIMEOUT_MS);

  it("X: validityOverride needs quotes:validity:override (403, no fallback); an authorized override is frozen; out of range is 422", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const override = { validThroughLocalDate: "2099-01-01", reasonCode: "tender_terms" };

    const denied = await harness.issue(quoteId, { body: { ...issueRequest(), validityOverride: override } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details).toEqual({ requiredScope: "quotes:validity:override" });

    // The supervisor (override scope) issues its own draft (A4: creator only).
    const ownDraft = await editedDraft(harness, "-s", TEST_TOKENS.supervisor);

    const outOfRange = await harness.issue(ownDraft, { token: TEST_TOKENS.supervisor, body: { ...issueRequest(), validityOverride: override } });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.error.details.fields[0].code).toBe("override_out_of_range");
    // Validity is resolved before the number is drawn: no gap for a rejected override.
    expect(await harness.footprint()).toMatchObject({ operations: 0, sequence: "1:false" });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
    const through = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    const allowed = await harness.issue(ownDraft, {
      token: TEST_TOKENS.supervisor,
      key: "issue-override",
      body: { ...issueRequest(), validityOverride: { validThroughLocalDate: through, reasonCode: "tender_terms", note: "audit only" } }
    });
    expect(allowed.status).toBe(202);
    expect(allowed.body.quote.validity).toMatchObject({ source: "override", policyId: null, validThroughLocalDate: through, override: { principalId: "supervisor", reasonCode: "tender_terms" } });
    const accepted = (await harness.events(ownDraft)).find((event) => event.event_type === "quote.issue.accepted")!;
    expect(accepted.data).toMatchObject({ validitySource: "override", overrideReasonCode: "tender_terms", overrideNote: "audit only" });
  }, TEST_TIMEOUT_MS);

  it("Y/Z: a replay after the transition returns the same number and operation; a new key gets a stable conflict", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const first = await harness.issue(quoteId);
    const replay = await harness.issue(quoteId, { correlationId: "retry-trace" });

    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.quote).toMatchObject({ quoteId, quoteNumber: first.body.quote.quoteNumber, status: "issuing", version: 3 });
    expect(replay.body.operation.operationId).toBe(first.body.operation.operationId);

    const again = await harness.issue(quoteId, { key: "issue-2" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId: first.body.operation.operationId } });

    const changed = await harness.issue(quoteId, { body: { expectedVersion: 2 } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("idempotency_key_conflict");
    expect(await harness.footprint()).toMatchObject({ operations: 1, sequence: "1:true" });
  }, TEST_TIMEOUT_MS);

  it("rejects: zero lines (422 lines_required), stale version (409), non-draft state (409), missing/invisible quote (404)", async () => {
    const harness = await start();
    const empty = await harness.createDraft({ body: { ...draftRequest(), lines: [] } });
    const lines = await harness.issue(empty.body.quoteId, { body: { expectedVersion: 1 } });
    expect(lines.status).toBe(422);
    expect(lines.body.error.details.fields).toEqual([{ path: "/lines", code: "lines_required", message: "Issue requires at least one line." }]);

    const quoteId = await editedDraft(harness, "-b");
    const stale = await harness.issue(quoteId, { body: { expectedVersion: 1 } });
    expect(stale.body.error).toMatchObject({ code: "version_conflict", details: { expectedVersion: 1, currentVersion: 2 } });

    // A create-and-issue quote: the sales caller has no quotes:issue (403); backoffice is not its creator → 404 (A4).
    const transactional = await harness.createAndIssue();
    expect((await harness.issue(transactional.body.quote.quoteId, { token: TEST_TOKENS.sales })).status).toBe(403);
    expect((await harness.issue(transactional.body.quote.quoteId, { body: { expectedVersion: 1 } })).body.error.code).toBe("quote_not_found");

    // The creator's own non-draft quote → 409 state (operation_in_progress while issuing).
    await harness.issue(quoteId, { key: "issue-b" });
    expect((await harness.issue(quoteId, { key: "issue-b2", body: { expectedVersion: 3 } })).body.error.code).toBe("operation_in_progress");

    expect((await harness.issue("00000000-0000-4000-8000-000000000000")).body.error.code).toBe("quote_not_found");
    expect(await harness.footprint()).toMatchObject({ operations: 2, sequence: "2:true" });
  }, TEST_TIMEOUT_MS);
});

describe("draft workflow — concurrency (real PostgreSQL)", () => {
  it("AA: concurrent identical issue requests (same key) converge on one number and one operation", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const responses = await Promise.all(Array.from({ length: 6 }, () => harness.issue(quoteId)));

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(202));
    expect(responses.filter((response) => response.headers.get("idempotent-replay") === null)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.quote.quoteNumber)).size).toBe(1);
    expect(new Set(responses.map((response) => response.body.operation.operationId)).size).toBe(1);
    expect(await harness.footprint()).toMatchObject({ quotes: 1, operations: 1, sequence: "1:true" });
  }, TEST_TIMEOUT_MS);

  it("AB: issue commands with different keys race; exactly one is accepted, the others get a stable 409", async () => {
    const harness = await start();
    const quoteId = await editedDraft(harness);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => harness.issue(quoteId, { key: `issue-race-${index}` })));
    const accepted = responses.filter((response) => response.status === 202);

    expect(accepted).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 202)) {
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject({ code: "operation_in_progress", details: { operationId: accepted[0]!.body.operation.operationId } });
    }

    expect(await harness.footprint()).toMatchObject({ quotes: 1, operations: 1, sequence: "1:true" });
    expect((await harness.events(quoteId)).filter((event) => event.event_type === "quote.issue.accepted")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("AC: edit vs issue from the same version — exactly one wins, never a lost update or a stale issue", async () => {
    const harness = await start();
    const outcomes: string[] = [];

    for (let round = 0; round < 8; round += 1) {
      const quoteId = await editedDraft(harness, `-${round}`);
      const edit = { ...updateRequest(), expectedVersion: 2, lines: [{ ...updateRequest().lines[0], quantity: { value: "20", unit: "m" } }] };
      const [edited, issued] = await Promise.all([
        harness.updateDraft(quoteId, { key: `race-edit-${round}`, body: edit }),
        harness.issue(quoteId, { key: `race-issue-${round}`, body: { expectedVersion: 2 } })
      ]);
      const row = await harness.quoteRow(quoteId);
      const quantity = (await harness.sql(`select quantity::text from quote_service.quote_lines where quote_id = $1 and position = 1`, [quoteId]))[0]!.quantity;

      if (edited.status === 200) {
        // A: the edit won; the issue saw version 3.
        expect(issued.status).toBe(409);
        expect(issued.body.error).toMatchObject({ code: "version_conflict", details: { expectedVersion: 2, currentVersion: 3 } });
        expect(row).toMatchObject({ status: "draft", version: 3, quote_number: null });
        expect(quantity).toBe("20.000000");
        outcomes.push("edit");
      } else {
        // B: the issue won with the v2 snapshot; the edit is refused.
        expect(issued.status).toBe(202);
        expect(edited.status).toBe(409);
        expect(edited.body.error.code).toBe("operation_in_progress");
        expect(row).toMatchObject({ status: "issuing", version: 3 });
        expect(quantity).toBe("15.000000");
        expect(issued.body.quote.totals).toEqual(ISSUED_TOTALS);
        outcomes.push("issue");
      }
    }

    // Every round had exactly one winner; issue winners each drew exactly one number.
    expect(outcomes).toHaveLength(8);
    expect(await harness.footprint()).toMatchObject({ operations: outcomes.filter((outcome) => outcome === "issue").length });
  }, 2 * TEST_TIMEOUT_MS);
});

describe("draft workflow — lost responses and secrets", () => {
  /** Holds the first response for `url` after commit, then drops the client connection. */
  async function withLostResponse(url: RegExp, send: (harness: Harness, signal: AbortSignal) => Promise<unknown>, beforeLoss?: (harness: Harness) => Promise<void>) {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = true;
    const harness = await start({
      beforeListen: (context) =>
        context.app.addHook("onSend", async (request) => {
          if (holdNext && url.test(request.url)) {
            holdNext = false;
            await held;
          }
        })
    });
    await beforeLoss?.(harness);
    const bindings = (await harness.footprint()).bindings as number;
    const controller = new AbortController();
    const lost = send(harness, controller.signal).catch((error: unknown) => error);

    await waitFor(async () => (await harness.footprint()).bindings === bindings + 1);
    controller.abort();
    expect(await lost).toBeInstanceOf(Error);
    release();
    return harness;
  }

  it("draft create: commit → response lost → replay returns the same draft", async () => {
    const harness = await withLostResponse(/\/v2\/quotes\/drafts$/, (h, signal) => h.createDraft({ signal }));
    const [committed] = await harness.sql(`select quote_id from quote_service.quotes`);
    const retry = await harness.createDraft();

    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(retry.body.quoteId).toBe(committed!.quote_id);
    expect(await harness.footprint()).toMatchObject({ quotes: 1, bindings: 1 });
  }, TEST_TIMEOUT_MS);

  it("draft issue: commit → response lost → replay returns the same quoteId, number and operation", async () => {
    let quoteId = "";
    const harness = await withLostResponse(
      /\/issue$/,
      (h, signal) => h.issue(quoteId, { signal }),
      async (h) => {
        quoteId = await editedDraft(h);
      }
    );
    const committed = await harness.quoteRow(quoteId);
    const retry = await harness.issue(quoteId);

    expect(retry.status).toBe(202);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(retry.body.quote).toMatchObject({ quoteId, quoteNumber: committed.quote_number, status: "issuing" });
    expect(retry.body.operation.operationId).toBe(committed.current_operation_id);
    expect(await harness.footprint()).toMatchObject({ quotes: 1, operations: 1, sequence: "1:true" });
  }, TEST_TIMEOUT_MS);

  it("AI: no credential or raw idempotency key reaches responses, audit or the database", async () => {
    const harness = await start();
    const rawKey = "raw-draft-key-that-must-never-be-stored-0001";
    const created = await harness.createDraft({ key: rawKey });
    const quoteId = created.body.quoteId;
    const responses = [
      created,
      await harness.updateDraft(quoteId, { key: rawKey }),
      await harness.updateDraft(quoteId, { key: rawKey, body: { expectedVersion: 9, lines: [] } }),
      await harness.issue(quoteId, { key: rawKey, body: { ...issueRequest(), expectedVersion: 2 } }),
      await harness.issue(quoteId, { key: rawKey, body: { ...issueRequest(), expectedVersion: 2 } })
    ];
    const [dump] = await harness.sql<{ text: string }>(
      `select concat_ws(' ',
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.quotes t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.idempotency_bindings t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.quote_audit_events t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.issuance_operations t)) as text`
    );
    const haystack = [...responses.map((response) => response.text), dump!.text].join("\n");

    for (const secret of [rawKey, TEST_TOKENS.backoffice, sha256Hex(TEST_TOKENS.backoffice), "Bearer "]) {
      expect(haystack).not.toContain(secret);
    }
    expect(dump!.text).toContain(sha256Hex(rawKey));
    // Audit data never carries customer PII or line payloads.
    const audit = JSON.stringify(await harness.events(quoteId));
    for (const pii of ["Gimnasio Andes", "76123456-0", "compras@andesfit", "Providencia 1234", "Piso de goma"]) {
      expect(audit).not.toContain(pii);
    }
  }, TEST_TIMEOUT_MS);
});
