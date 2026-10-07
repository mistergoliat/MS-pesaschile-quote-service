/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import { resolveValidity } from "../../src/application/quote-v2/validity";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { r15aSemanticSnapshotHash } from "../helpers/r15a-snapshot-hash";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase, type TestDatabaseHandle } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS } from "../helpers/test-principals";

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

const contractExample = (name: string): AnyRecord =>
  JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
/** The frozen create-and-issue request (person customer, two lines, shipping, expectedTotals). */
const createRequest = (): AnyRecord => contractExample("create-and-issue.request.json");

interface Harness {
  readonly context: ApplicationContext;
  readonly database: TestDatabaseHandle;
  readonly baseUrl: string;
  readonly sql: <T extends pg.QueryResultRow = AnyRecord>(text: string, values?: unknown[]) => Promise<T[]>;
  post(options: {
    token?: string;
    key?: string | null;
    correlationId?: string;
    body?: unknown;
    rawBody?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: AnyRecord; text: string; headers: Headers }>;
}

async function start(
  options: { migrate?: boolean; databaseUrl?: string; logs?: string[]; beforeListen?: (context: ApplicationContext) => void } = {}
): Promise<Harness> {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());

  if (options.migrate ?? true) {
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  }

  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-v2-create-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const context = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: options.databaseUrl ?? database.connectionString,
      storageRoot,
      overrides: { LOG_LEVEL: options.logs ? "trace" : "silent" }
    }),
    {
      // Acceptance-only suite: quotes must stay `issuing` (issuance execution is covered in issuance-commit tests).
      disableIssuanceExecution: true,
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {})
    }
  );
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  options.beforeListen?.(context);
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());

  return {
    context,
    database,
    baseUrl,
    sql: async (text, values = []) => (await admin.query(text, values)).rows,
    async post({ token = TEST_TOKENS.sales, key = "key-1", correlationId, body = createRequest(), rawBody, signal }) {
      const headers: Record<string, string> = { Authorization: bearer(token), "Content-Type": "application/json" };

      if (key !== null) {
        headers["Idempotency-Key"] = key;
      }

      if (correlationId !== undefined) {
        headers["X-Correlation-Id"] = correlationId;
      }

      const response = await fetch(`${baseUrl}/v2/quotes`, {
        method: "POST",
        headers,
        body: rawBody ?? JSON.stringify(body),
        ...(signal ? { signal } : {})
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, text, headers: response.headers };
    }
  };
}

/** Durable footprint of the acceptance path, used to prove "zero writes". */
async function footprint(harness: Harness) {
  const [counts] = await harness.sql(
    `select (select count(*)::int from quote_service.quotes) as quotes,
            (select count(*)::int from quote_service.quote_lines) as lines,
            (select count(*)::int from quote_service.quote_shipping) as shipping,
            (select count(*)::int from quote_service.issuance_operations) as operations,
            (select count(*)::int from quote_service.idempotency_bindings) as bindings,
            (select count(*)::int from quote_service.quote_audit_events) as audit,
            (select count(*)::int from quote_service.quote_documents) as documents,
            (select count(*)::int from quote_service.quote_deliveries) as deliveries,
            (select last_value::text || ':' || is_called::text from quote_service.quote_number_seq) as sequence`
  );
  return counts!;
}

const ZERO = { quotes: 0, lines: 0, shipping: 0, operations: 0, bindings: 0, audit: 0, documents: 0, deliveries: 0, sequence: "1:false" };

describe("POST /v2/quotes — acceptance", () => {
  it("A/S/T/U/V/W/X: accepts once, durably, as issuing with a pending operation and no document or email", async () => {
    const harness = await start();
    const response = await harness.post({ correlationId: "trace-req-001" });
    const { quote, operation } = response.body;

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/v2/operations/${operation.operationId}`);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get("idempotent-replay")).toBeNull();

    // Shape of the frozen QuoteOperationResult (same members as the contract's 202 example).
    const frozen = contractExample("create-and-issue.response-202.json");
    expect(Object.keys(quote).sort()).toEqual(Object.keys(frozen.quote).sort());
    expect(Object.keys(operation).sort()).toEqual(Object.keys(frozen.operation).sort());

    // Same commercial content and owner totals as the frozen example.
    expect(quote).toMatchObject({
      status: "issuing",
      version: 1,
      quoteNumber: "PC-000001",
      currency: "CLP",
      externalCorrelation: createRequest().externalCorrelation,
      customer: frozen.quote.customer,
      shipping: frozen.quote.shipping,
      totals: frozen.quote.totals,
      createdByPrincipalId: "sales-integration",
      document: frozen.quote.document,
      cancellation: null,
      expiration: null
    });
    const withoutLineId = (line: AnyRecord) => Object.fromEntries(Object.entries(line).filter(([key]) => key !== "lineId"));
    expect(quote.lines.map(withoutLineId)).toEqual(frozen.quote.lines.map(withoutLineId));
    expect(quote.issuance).toEqual({ issuedAt: quote.createdAt, operationId: operation.operationId, issuerProfileId: "pesaschile-cl-v1" });
    expect(quote.validity).toEqual(resolveValidity(Date.parse(quote.issuance.issuedAt)));
    expect(operation).toEqual({
      operationId: operation.operationId,
      type: "quote.issue",
      status: "pending",
      quoteId: quote.quoteId,
      acceptedAt: quote.issuance.issuedAt,
      deadlineAt: new Date(Date.parse(quote.issuance.issuedAt) + 24 * 3_600_000).toISOString().replace(".000Z", "Z"),
      completedAt: null,
      attempts: { count: 0, lastAttemptAt: null, lastErrorCode: null, nextAttemptAt: quote.issuance.issuedAt }
    });

    expect(await footprint(harness)).toEqual({ ...ZERO, quotes: 1, lines: 2, shipping: 1, operations: 1, bindings: 1, audit: 1, sequence: "1:true" });

    // The operation carries the semantic snapshot hash of what was persisted.
    const [stored] = await harness.sql(`select snapshot_hash, snapshot_hash_algorithm, origin, generation from quote_service.issuance_operations`);
    expect(stored).toEqual({ snapshot_hash: r15aSemanticSnapshotHash(quote), snapshot_hash_algorithm: "jcs-sha256-v2", origin: "acceptance", generation: "0" });

    // W/X: durable business correlation stored; the request trace is audit-only.
    const [row] = await harness.sql(`select source_system, external_reference_type, external_reference, to_jsonb(q)::text as dump from quote_service.quotes q`);
    expect(row).toMatchObject({ source_system: "sales-integration", external_reference_type: "conversation", external_reference: "conv-7f3a91c2" });
    expect(row!.dump).not.toContain("trace-req-001");

    // Acceptance audit evidence.
    const [audit] = await harness.sql(`select * from quote_service.quote_audit_events`);
    expect(audit).toMatchObject({
      quote_id: quote.quoteId,
      sequence: 1,
      event_type: "quote.issue.accepted",
      principal_id: "sales-integration",
      operation_id: operation.operationId,
      correlation_id: "trace-req-001",
      idempotency_key_hash: sha256Hex("key-1"),
      from_status: null,
      to_status: "issuing",
      data: {
        quoteNumber: "PC-000001",
        lineCount: 2,
        hasShipping: true,
        gross: 147098,
        validitySource: "policy",
        validityPolicyId: "cl-retail-5-calendar-days-v1",
        tzdbVersion: quote.validity.tzdbVersion,
        externalReferenceType: "conversation",
        externalReference: "conv-7f3a91c2"
      }
    });
  }, TEST_TIMEOUT_MS);

  it("B: a principal without quotes:create gets 403 and nothing is written", async () => {
    const harness = await start();
    const response = await harness.post({ token: TEST_TOKENS.backoffice });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: "forbidden", details: { requiredScope: "quotes:create" } });
    expect(await footprint(harness)).toEqual(ZERO);
    expect((await harness.post({ token: "x".repeat(60) })).status).toBe(401);
  }, TEST_TIMEOUT_MS);

  it("C: invalid requests are rejected with no durable write and no number consumed", async () => {
    const harness = await start();
    const v1Shaped = { ...createRequest(), opportunityId: "opp-1", validUntil: "2026-10-09T03:00:00Z" };

    const invalid = await harness.post({ body: v1Shaped });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toMatchObject({ code: "validation_error" });
    expect(invalid.body.error.details.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/opportunityId", code: "unknown_member" }),
        expect.objectContaining({ path: "/validUntil", code: "unknown_member" })
      ])
    );

    expect((await harness.post({ key: null })).body.error.code).toBe("invalid_request");
    expect((await harness.post({ key: "has space" })).status).toBe(400);
    // Leading whitespace is stripped by HTTP itself; an over-long trace id survives transport.
    expect((await harness.post({ correlationId: "t".repeat(201) })).status).toBe(400);
    expect((await harness.post({ rawBody: "{not json" })).body.error.code).toBe("invalid_request");
    expect(await footprint(harness)).toEqual(ZERO);
  }, TEST_TIMEOUT_MS);

  it("D: expectedTotals that differ from owner arithmetic → 422 arithmetic_mismatch, nothing accepted", async () => {
    const harness = await start();
    const body = createRequest();
    body.expectedTotals.gross += 1;
    const response = await harness.post({ body });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "arithmetic_mismatch",
      details: { expected: body.expectedTotals, computed: { net: 123612, tax: 23486, gross: 147098 } }
    });
    expect(await footprint(harness)).toEqual(ZERO);
  }, TEST_TIMEOUT_MS);

  it("F: validityOverride without the override scope → 403, never a silent fallback", async () => {
    const harness = await start();
    const response = await harness.post({
      body: { ...createRequest(), validityOverride: { validThroughLocalDate: "2099-01-01", reasonCode: "campaign_hold" } }
    });

    expect(response.status).toBe(403);
    expect(response.body.error.details).toEqual({ requiredScope: "quotes:validity:override" });
    expect(await footprint(harness)).toEqual(ZERO);
  }, TEST_TIMEOUT_MS);

  it("G: an authorized override is frozen and audited; out-of-range overrides are 422", async () => {
    const harness = await start();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
    const plus = (days: number) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };

    const outOfRange = await harness.post({
      token: TEST_TOKENS.pricingDesk,
      key: "override-far",
      body: { ...createRequest(), validityOverride: { validThroughLocalDate: plus(400), reasonCode: "campaign_hold" } }
    });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.error.details.fields).toEqual([expect.objectContaining({ code: "override_out_of_range" })]);
    expect((await footprint(harness)).quotes).toBe(0);

    const response = await harness.post({
      token: TEST_TOKENS.pricingDesk,
      key: "override-ok",
      body: { ...createRequest(), validityOverride: { validThroughLocalDate: plus(20), reasonCode: "campaign_hold", note: "Approved by sales lead" } }
    });
    expect(response.status).toBe(202);
    expect(response.body.quote.validity).toMatchObject({
      source: "override",
      policyId: null,
      validThroughLocalDate: plus(20),
      override: { principalId: "pricing-desk", reasonCode: "campaign_hold" }
    });
    const [audit] = await harness.sql(`select data from quote_service.quote_audit_events where event_type = 'quote.issue.accepted'`);
    expect(audit!.data).toMatchObject({ validitySource: "override", overrideReasonCode: "campaign_hold", overrideNote: "Approved by sales lead" });
    // The note is audit-only, never on the quote.
    const [quote] = await harness.sql(`select validity_override_note from quote_service.quotes`);
    expect(quote!.validity_override_note).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("H: structured shipping is persisted as given with owner-computed amounts", async () => {
    const harness = await start();
    await harness.post({});

    expect(await harness.sql(`select carrier_code, carrier_name, service_type_code, service_type_name, destination_commune, destination_region,
                                     destination_country, amount, tax_basis, tax_rate::text, source_quote_system, source_quote_reference,
                                     source_quote_as_of = '2026-10-04T17:59:40Z'::timestamptz as as_of_preserved, net_amount, tax_amount, gross_amount
                              from quote_service.quote_shipping`)).toEqual([
      {
        carrier_code: "starken", carrier_name: "Starken", service_type_code: "domicilio", service_type_name: "Entrega a domicilio",
        destination_commune: "Ñuñoa", destination_region: "Región Metropolitana", destination_country: "CL",
        amount: "5990", tax_basis: "excluded", tax_rate: "0.190000", source_quote_system: "pc-carrier", source_quote_reference: "all-offers",
        as_of_preserved: true, net_amount: "5990", tax_amount: "1138", gross_amount: "7128"
      }
    ]);
  }, TEST_TIMEOUT_MS);

  it.each(["customer.guest.json", "customer.guest-with-contact.json", "customer.person.json", "customer.company.json"])(
    "I: frozen customer %s is stored and returned exactly as given",
    async (name) => {
      const harness = await start();
      const customer = contractExample(name);
      const response = await harness.post({ body: { ...createRequest(), customer } });

      expect(response.status).toBe(202);
      expect(response.body.quote.customer).toEqual(customer);
      expect((await harness.sql(`select customer from quote_service.quotes`))[0]!.customer).toEqual(customer);
    },
    TEST_TIMEOUT_MS
  );
});

describe("POST /v2/quotes — idempotency", () => {
  it("J/L: the same request replays the same quote, even with a different X-Correlation-Id", async () => {
    const harness = await start();
    const first = await harness.post({ correlationId: "trace-a" });
    const before = await footprint(harness);
    const replay = await harness.post({ correlationId: "trace-b" });
    const reordered = await harness.post({ body: Object.fromEntries(Object.entries(createRequest()).reverse()) });

    for (const response of [replay, reordered]) {
      expect(response.status).toBe(202);
      expect(response.headers.get("idempotent-replay")).toBe("true");
      expect(response.body).toEqual(first.body);
    }

    expect(await footprint(harness)).toEqual({ ...before, audit: before.audit + 2 });
    expect(await harness.sql(`select event_type, correlation_id from quote_service.quote_audit_events order by sequence`)).toEqual([
      { event_type: "quote.issue.accepted", correlation_id: "trace-a" },
      { event_type: "idempotency.replayed", correlation_id: "trace-b" },
      { event_type: "idempotency.replayed", correlation_id: null }
    ]);
  }, TEST_TIMEOUT_MS);

  it("K: the same key with a different semantic request → 409, never a second quote", async () => {
    const harness = await start();
    await harness.post({});
    const changed = createRequest();
    changed.lines[0].quantity.value = "3";
    delete changed.expectedTotals;

    const conflict = await harness.post({ body: changed });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: "idempotency_key_conflict",
      details: { operation: "quote.create_and_issue", boundRequestFingerprint: sha256Hex(JSON.stringify(null)).length === 64 ? expect.stringMatching(/^[0-9a-f]{64}$/) : "" }
    });
    // Binding lookup precedes validation (Domain §12): even an invalid body under a bound key conflicts.
    expect((await harness.post({ body: { nonsense: true } })).status).toBe(409);
    expect((await footprint(harness)).quotes).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("M: the same raw key under different principals creates independent quotes", async () => {
    const harness = await start();
    const sales = await harness.post({ token: TEST_TOKENS.sales, key: "shared-key" });
    const desk = await harness.post({ token: TEST_TOKENS.pricingDesk, key: "shared-key" });

    expect(sales.status).toBe(202);
    expect(desk.status).toBe(202);
    expect(desk.headers.get("idempotent-replay")).toBeNull();
    expect(desk.body.quote.quoteId).not.toBe(sales.body.quote.quoteId);
    expect(desk.body.quote.quoteNumber).not.toBe(sales.body.quote.quoteNumber);
    expect(await harness.sql(`select principal_id from quote_service.idempotency_bindings order by principal_id`)).toEqual([
      { principal_id: "pricing-desk" },
      { principal_id: "sales-integration" }
    ]);
  }, TEST_TIMEOUT_MS);

  it("N: concurrent first requests with the same key and body converge on exactly one quote", async () => {
    const harness = await start();
    const responses = await Promise.all(Array.from({ length: 6 }, () => harness.post({ key: "race-key" })));

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(202));
    expect(responses.filter((response) => response.headers.get("idempotent-replay") === null)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.quote.quoteId)).size).toBe(1);
    expect(new Set(responses.map((response) => response.body.operation.operationId)).size).toBe(1);
    expect(await footprint(harness)).toMatchObject({ quotes: 1, operations: 1, bindings: 1, sequence: "1:true" });
  }, TEST_TIMEOUT_MS);

  it("O: concurrent same-key requests with different bodies → one accepted, one conflict", async () => {
    const harness = await start();
    const other = createRequest();
    other.lines[1].quantity.value = "2";
    delete other.expectedTotals;
    const responses = await Promise.all([harness.post({ key: "race-key" }), harness.post({ key: "race-key", body: other })]);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(responses.find((response) => response.status === 409)!.body.error.code).toBe("idempotency_key_conflict");
    expect(await footprint(harness)).toMatchObject({ quotes: 1, operations: 1, bindings: 1 });
  }, TEST_TIMEOUT_MS);

  it("P: a response lost after commit is recovered by retrying the same request", async () => {
    let release: () => void = () => undefined;
    const responseHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = true;
    // Hold the first response after the transaction committed, then drop the connection.
    const harness = await start({
      beforeListen: (context) =>
        context.app.addHook("onSend", async (request) => {
          if (holdNext && request.url === "/v2/quotes") {
            holdNext = false;
            await responseHeld;
          }
        })
    });
    const controller = new AbortController();
    const lost = harness.post({ key: "lost-key", signal: controller.signal }).catch((error: unknown) => error);

    await waitFor(async () => (await harness.sql(`select count(*)::int as n from quote_service.idempotency_bindings`))[0]!.n === 1);
    controller.abort();
    expect(await lost).toBeInstanceOf(Error);
    release();

    const [committed] = await harness.sql(`select quote_id, quote_number, current_operation_id from quote_service.quotes`);
    const retry = await harness.post({ key: "lost-key" });

    expect(retry.status).toBe(202);
    expect(retry.headers.get("idempotent-replay")).toBe("true");
    expect(retry.body.quote).toMatchObject({ quoteId: committed!.quote_id, quoteNumber: committed!.quote_number });
    expect(retry.body.operation.operationId).toBe(committed!.current_operation_id);
    expect(await footprint(harness)).toMatchObject({ quotes: 1, operations: 1, bindings: 1 });
  }, TEST_TIMEOUT_MS);
});

describe("POST /v2/quotes — numbering, atomicity, readiness, secrets", () => {
  it("Q: numbers above 999999 are never truncated", async () => {
    const harness = await start();
    await harness.sql(`select setval('quote_service.quote_number_seq', 999999)`);

    expect((await harness.post({ key: "q-1" })).body.quote.quoteNumber).toBe("PC-1000000");
    expect((await harness.post({ key: "q-2" })).body.quote.quoteNumber).toBe("PC-1000001");
  }, TEST_TIMEOUT_MS);

  it("R: a failure after number allocation rolls everything back, leaving only a sequence gap", async () => {
    const harness = await start();
    await harness.sql(`create function public.fail_operation_insert() returns trigger language plpgsql as $$
                       begin raise exception 'injected failure'; end $$`);
    await harness.sql(`create trigger fail_operation_insert before insert on quote_service.issuance_operations
                       for each row execute function public.fail_operation_insert()`);

    const failed = await harness.post({ key: "r-1" });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("internal_error");
    expect(failed.text).not.toContain("injected failure");
    expect(await footprint(harness)).toEqual({ ...ZERO, sequence: "1:true" });

    await harness.sql(`drop trigger fail_operation_insert on quote_service.issuance_operations`);
    // Nothing was bound, so the same key now proceeds normally; the gap stays.
    const retried = await harness.post({ key: "r-1" });
    expect(retried.status).toBe(202);
    expect(retried.body.quote.quoteNumber).toBe("PC-000002");
  }, TEST_TIMEOUT_MS);

  it("Y: the readiness gate answers 503 before anything else when the database is down or unmigrated", async () => {
    const down = await start({ databaseUrl: "postgres://quote:quote@127.0.0.1:1/quote" });
    const unavailable = await down.post({});
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "database" } });

    const unmigrated = await start({ migrate: false });
    const notReady = await unmigrated.post({});
    expect(notReady.status).toBe(503);
    expect(notReady.body.error.code).toBe("schema_not_ready");
  }, TEST_TIMEOUT_MS);

  it("Z: no credential or raw idempotency key appears in logs, responses, audit or the database", async () => {
    const logs: string[] = [];
    const harness = await start({ logs });
    const rawKey = "raw-key-that-must-never-be-stored-0001";
    const responses = [
      await harness.post({ key: rawKey, correlationId: "trace-z" }),
      await harness.post({ key: rawKey }),
      await harness.post({ key: rawKey, body: { ...createRequest(), lines: [] } }),
      await harness.post({ token: TEST_TOKENS.backoffice, key: rawKey })
    ];
    const [dump] = await harness.sql<{ text: string }>(
      `select concat_ws(' ',
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.quotes t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.idempotency_bindings t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.quote_audit_events t),
         (select string_agg(to_jsonb(t)::text, ' ') from quote_service.issuance_operations t)) as text`
    );
    const haystack = [logs.join("\n"), ...responses.map((response) => response.text), dump!.text].join("\n");

    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [rawKey, TEST_TOKENS.sales, TEST_TOKENS.backoffice, sha256Hex(TEST_TOKENS.sales), "Bearer "]) {
      expect(haystack).not.toContain(secret);
    }
    // Only the key hash is persisted.
    expect(dump!.text).toContain(sha256Hex(rawKey));
  }, TEST_TIMEOUT_MS);
});
