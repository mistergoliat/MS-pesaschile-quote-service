/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/app";
import type { MailSenderPort, OutboundMail } from "../../src/application/quote-v2/delivery/mail-sender-port";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { databaseClock, type QuoteClock } from "../../src/infrastructure/persistence/postgres/quote-clock";
import { responseErrors, schemaErrors } from "../helpers/openapi-contract";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS as SHARED_TOKENS, testRegistryDocument } from "../helpers/test-principals";
import { HOSTILE_RECIPIENTS } from "../helpers/hostile-recipients";

/*
 * R1.6A — V2 email delivery request and read core, on real PostgreSQL.
 * Every suite composes a SPY mail sender (or none). R1.6A must never call it:
 * `afterEach` asserts zero `send()` calls across every test (AO).
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Response = { status: number; body: AnyRecord; text: string; headers: Headers };

const TEST_TIMEOUT_MS = 60_000;
const POST_PATH = "/v2/quotes/{quoteId}/deliveries/email";
const GET_PATH = "/v2/quotes/{quoteId}/deliveries/{deliveryId}";
const UNKNOWN_ID = "7d3f0a9e-1b2c-4d5e-8f60-718293a4b5c6";
const TOKENS = {
  ...SHARED_TOKENS,
  clerk: "test-delivery-clerk-own-quotes-token-0123456789abcdefghijk",
  clerk2: "test-delivery-second-clerk-token-0123456789abcdefghijklmno",
  comms: "test-delivery-customer-communication-token-0123456789abcd",
  senderOnly: "test-delivery-sender-only-token-0123456789abcdefghijklmn",
  operatorRead: "test-delivery-operator-read-only-token-0123456789abcdefgh"
};

/**
 * Shared registry plus: two clerks that may draft, issue, read, cancel, audit
 * and email their OWN quotes; the contract's "customer communication"
 * profile (read, read:any, delivery:email); a principal holding only the
 * delivery scope; and an `operator` principal with read only (principalType
 * alone must grant nothing).
 */
function registry(): PrincipalRegistry {
  const document = testRegistryDocument();
  const own = ["quotes:draft:write", "quotes:issue", "quotes:read", "quotes:cancel", "quotes:audit:read", "quotes:delivery:email"];
  document.principals.push(
    { principalId: "clerk", principalType: "operator", scopes: own, tokenSha256: [sha256Hex(TOKENS.clerk)] },
    { principalId: "clerk-two", principalType: "operator", scopes: own, tokenSha256: [sha256Hex(TOKENS.clerk2)] },
    {
      principalId: "customer-comms",
      principalType: "service",
      scopes: ["quotes:read", "quotes:read:any", "quotes:delivery:email"],
      tokenSha256: [sha256Hex(TOKENS.comms)]
    },
    { principalId: "sender-only", principalType: "service", scopes: ["quotes:delivery:email"], tokenSha256: [sha256Hex(TOKENS.senderOnly)] },
    { principalId: "operator-read", principalType: "operator", scopes: ["quotes:read", "quotes:read:any"], tokenSha256: [sha256Hex(TOKENS.operatorRead)] }
  );
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}

class TestClock implements QuoteClock {
  pinned: Date | null = null;

  now(queryable: Parameters<QuoteClock["now"]>[0]): Promise<Date> {
    return this.pinned ? Promise.resolve(this.pinned) : databaseClock.now(queryable);
  }
}

/** One spy for every composition in this file: R1.6A must never send (AO). */
const sent: OutboundMail[] = [];
const spySender: MailSenderPort = {
  send: (mail) => {
    sent.push(mail);
    return Promise.resolve({ kind: "accepted", providerMessageId: null });
  }
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }

  expect(sent, "R1.6A must never call MailSenderPort.send()").toHaveLength(0);
}, 30_000);

const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const DELIVERY_KEYS = Object.keys(example("delivery.response.json")).sort();
const draftBody = (customer?: AnyRecord): AnyRecord => {
  const body = example("draft-create.request.json");
  return customer ? { ...body, customer } : body;
};
const COMPANY_EMAIL = "compras@andesfit.example.com";
const EXPLICIT = { email: "camila.rojas@example.com", name: "Camila Rojas" };

interface CallOptions {
  token?: string;
  key?: string | null;
  body?: unknown;
  rawBody?: string;
}

interface StartOptions {
  /** Compose the spy sender (email "configured"); default true. */
  mail?: boolean;
  /** Reuse an existing, migrated database (second composition over the same data). */
  databaseUrl?: string;
  /** Run real issuance (renderer + store); default: acceptance only. */
  issuance?: boolean;
  logs?: string[];
}

async function start(options: StartOptions = {}) {
  let connectionString = options.databaseUrl;

  if (!connectionString) {
    const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => database.dispose());
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
    connectionString = database.connectionString;
  }

  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-v2-delivery-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const clock = new TestClock();
  const context = buildApplication(
    buildRuntimeTestEnv({ databaseUrl: connectionString, storageRoot, overrides: { LOG_LEVEL: options.logs ? "trace" : "silent" } }),
    {
      principalRegistry: registry(),
      quoteClock: clock,
      ...(options.issuance ? {} : { disableIssuanceExecution: true }),
      ...((options.mail ?? true) ? { testMailSender: spySender } : {}),
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {})
    }
  );
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  // Spies: a delivery request must never render, publish or read document bytes (AF, AG).
  const renderSpy = vi.spyOn(context.pdfRenderer, "renderPdf");
  const publishSpy = vi.spyOn(context.artifactStorage, "publish");
  const readSpy = vi.spyOn(context.artifactStorage, "readVerified");
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  await waitFor(async () => (await fetch(`${baseUrl}/health/ready`)).status === 200, 20_000, 50);
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());

  async function call(method: string, pathname: string, { token = TOKENS.clerk, key = null, body, rawBody }: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: bearer(token) };

    if (body !== undefined || rawBody !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (key !== null) {
      headers["Idempotency-Key"] = key;
    }

    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, text, headers: response.headers };
  }

  const sql = async <T extends pg.QueryResultRow = AnyRecord>(text: string, values: unknown[] = []) => (await admin.query<T>(text, values)).rows;

  const harness = {
    context,
    clock,
    sql,
    call,
    connectionString,
    renderSpy,
    publishSpy,
    readSpy,
    deliver: (quoteId: string, options: CallOptions = {}) =>
      call("POST", `/v2/quotes/${quoteId}/deliveries/email`, { key: `delivery-${crypto.randomUUID()}`, body: {}, ...options }),
    getDelivery: (quoteId: string, deliveryId: string, token: string = TOKENS.clerk) => call("GET", `/v2/quotes/${quoteId}/deliveries/${deliveryId}`, { token }),
    lookup: (key: string, token: string = TOKENS.clerk) => call("GET", "/v2/idempotency/current?operation=quote.delivery.email", { token, key }),
    cancel: (quoteId: string, expectedVersion: number, options: CallOptions = {}) =>
      call("POST", `/v2/quotes/${quoteId}/cancel`, {
        key: `cancel-${crypto.randomUUID()}`,
        body: { expectedVersion, reasonCode: "customer_declined" },
        ...options
      }),

    async draft(token: string = TOKENS.clerk, customer?: AnyRecord): Promise<AnyRecord> {
      const created = await call("POST", "/v2/quotes/drafts", { token, key: `draft-${crypto.randomUUID()}`, body: draftBody(customer) });
      expect(created.status).toBe(201);
      return created.body;
    },
    async issuing(token: string = TOKENS.clerk, customer?: AnyRecord): Promise<{ quoteId: string; operationId: string }> {
      const draft = await harness.draft(token, customer);
      const issued = await call("POST", `/v2/quotes/${draft.quoteId}/issue`, { token, key: `issue-${crypto.randomUUID()}`, body: { expectedVersion: 1 } });
      expect(issued.status).toBe(202);
      return { quoteId: draft.quoteId, operationId: issued.body.operation.operationId };
    },
    /** Simulates the fenced manifest commit (T5) of the issuance worker: operation succeeded, manifest, quote issued. */
    async issued(token: string = TOKENS.clerk, customer?: AnyRecord): Promise<{ quoteId: string; pdfSha256: string; validUntilExclusive: Date }> {
      const { quoteId, operationId } = await harness.issuing(token, customer);
      const pdfSha256 = sha256Hex(`pdf-${quoteId}`);
      await admin.query("begin");
      await admin.query(
        `update quote_service.issuance_operations
         set status = 'succeeded', generation = generation + 1, attempt_count = attempt_count + 1, last_attempt_at = now(),
             completed_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
         where operation_id = $1`,
        [operationId]
      );
      await admin.query(
        `insert into quote_service.quote_documents (
           document_id, quote_id, operation_id, origin, content_type, semantic_snapshot_hash, semantic_hash_algorithm,
           pdf_sha256, byte_length, renderer_version, template_version, generated_at, storage_key, committed_at
         ) select $1, $2, o.operation_id, 'issuance', 'application/pdf', o.snapshot_hash, 'jcs-sha256-v2', $3, 4321,
                  'quote-pdf-v4', 'quote-template-v4', now(),
                  'artifacts/sha256/' || substr($3, 1, 2) || '/' || substr($3, 3, 2) || '/' || $3 || '.pdf', now()
           from quote_service.issuance_operations o where o.operation_id = $4`,
        [crypto.randomUUID(), quoteId, pdfSha256, operationId]
      );
      await admin.query(`update quote_service.quotes set status = 'issued', version = version + 1, updated_at = now() where quote_id = $1`, [quoteId]);
      await admin.query("commit");
      const [quote] = await sql(`select valid_until_exclusive from quote_service.quotes where quote_id = $1`, [quoteId]);
      return { quoteId, pdfSha256, validUntilExclusive: quote!.valid_until_exclusive };
    },
    async markOperationFailed(operationId: string) {
      await sql(
        `update quote_service.issuance_operations
         set status = 'failed', generation = generation + 1, last_error_code = 'issuance_deadline_exceeded', completed_at = now(),
             lease_owner = null, lease_expires_at = null, updated_at = now()
         where operation_id = $1`,
        [operationId]
      );
    },
    async quoteRow(quoteId: string) {
      return (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    async deliveryRows(quoteId: string) {
      return sql(`select * from quote_service.quote_deliveries where quote_id = $1 order by requested_at, delivery_id`, [quoteId]);
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
        `select (select count(*)::int from quote_service.quote_deliveries) as deliveries,
                (select count(*)::int from quote_service.idempotency_bindings where operation = 'quote.delivery.email') as bindings,
                (select count(*)::int from quote_service.quote_audit_events where event_type like 'quote.delivery.%') as "deliveryEvents",
                (select count(*)::int from quote_service.quote_documents) as documents`
      );
      return counts!;
    }
  };

  return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

function expectPost(response: Response, status: number): void {
  expect(response.status, response.text).toBe(status);
  expect(responseErrors(POST_PATH, "post", status, response.body), response.text).toEqual([]);
}

function expectGet(response: Response, status: number): void {
  expect(response.status, response.text).toBe(status);
  expect(responseErrors(GET_PATH, "get", status, response.body), response.text).toEqual([]);
}

function expectError(response: Response, status: number, code: string, details?: AnyRecord): void {
  expectPost(response, status);
  expect(response.body.error.code).toBe(code);

  if (details) {
    expect(response.body.error.details).toEqual(details);
  }
}

describe("R1.6A delivery request: authorization (security §2–§3; A4 not extended)", () => {
  it(
    "A–E: own → 202; foreign + read:any → 202; foreign without visibility → 404; read:any without the scope → 403; principalType alone → 403",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();

      const own = await harness.deliver(quoteId, { token: TOKENS.clerk });
      expectPost(own, 202);

      const crossPrincipal = await harness.deliver(quoteId, { token: TOKENS.comms });
      expectPost(crossPrincipal, 202);
      expect(crossPrincipal.body.deliveryId).not.toBe(own.body.deliveryId);

      expectError(await harness.deliver(quoteId, { token: TOKENS.clerk2 }), 404, "quote_not_found");
      expectError(await harness.deliver(quoteId, { token: TOKENS.senderOnly }), 404, "quote_not_found");
      expectError(await harness.deliver(quoteId, { token: TOKENS.backoffice }), 403, "forbidden", { requiredScope: "quotes:delivery:email" });
      expectError(await harness.deliver(quoteId, { token: TOKENS.operatorRead }), 403, "forbidden", { requiredScope: "quotes:delivery:email" });
      expectError(await harness.deliver(UNKNOWN_ID, { token: TOKENS.comms }), 404, "quote_not_found");

      // Exactly the two authorized requests produced state.
      expect(await harness.counts()).toMatchObject({ deliveries: 2, bindings: 2 });
      const requesters = (await harness.deliveryRows(quoteId)).map((row) => row.requested_by_principal_id).sort();
      expect(requesters).toEqual(["clerk", "customer-comms"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a forbidden request is rejected before the binding lookup: it never replays and never binds",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const key = "shared-key-403";
      expectPost(await harness.deliver(quoteId, { token: TOKENS.clerk, key }), 202);
      expectError(await harness.deliver(quoteId, { token: TOKENS.backoffice, key }), 403, "forbidden");
      expect((await harness.counts()).bindings).toBe(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "400 (key, path, JSON), 401 and 413 are contract errors and bind nothing",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();

      expectError(await harness.deliver(quoteId, { key: null }), 400, "invalid_request");
      expectError(await harness.deliver(quoteId, { key: "has space" }), 400, "invalid_request");
      expectError(await harness.deliver("not-a-uuid"), 400, "invalid_request");
      expectError(await harness.deliver(quoteId, { rawBody: "{not json" }), 400, "invalid_request");
      expectError(await harness.deliver(quoteId, { token: "not-a-registered-token-0123456789abcdefghijklmnop" }), 401, "unauthenticated");
      // 413 is a contract error (Domain §12) that openapi does not list per operation: check the envelope schema.
      const tooLarge = await harness.deliver(quoteId, { body: { recipient: { email: EXPLICIT.email, name: "x".repeat(2 * 1024 * 1024) } } });
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error.code).toBe("payload_too_large");
      expect(schemaErrors("ErrorResponse", tooLarge.body)).toEqual([]);

      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0 });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A delivery request: effective-state eligibility (state machine §4)", () => {
  it(
    "F, G, H, M, N: draft, issuing (pending and failed operation), cancelled after and before issue → 409 with details.status",
    async () => {
      const harness = await start();
      const draft = await harness.draft();
      expectError(await harness.deliver(draft.quoteId), 409, "invalid_state_transition", { status: "draft" });

      const pending = await harness.issuing();
      expectError(await harness.deliver(pending.quoteId), 409, "invalid_state_transition", { status: "issuing" });

      const failed = await harness.issuing();
      await harness.markOperationFailed(failed.operationId);
      expectError(await harness.deliver(failed.quoteId), 409, "invalid_state_transition", { status: "issuing" });

      const issued = await harness.issued();
      const cancel = await harness.cancel(issued.quoteId, (await harness.quoteRow(issued.quoteId)).version);
      expect(cancel.status).toBe(200);
      expectError(await harness.deliver(issued.quoteId), 409, "invalid_state_transition", { status: "cancelled" });

      const cancelledDraft = await harness.draft();
      expect((await harness.cancel(cancelledDraft.quoteId, 1)).status).toBe(200);
      expectError(await harness.deliver(cancelledDraft.quoteId), 409, "invalid_state_transition", { status: "cancelled" });

      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "I, J, K, L: issued before the boundary → 202; at and after validUntilExclusive (projection) and materialized expired → 409 expired",
    async () => {
      const harness = await start();
      const { quoteId, validUntilExclusive } = await harness.issued();
      const boundary = validUntilExclusive.getTime();

      harness.clock.pinned = new Date(boundary - 1);
      expectPost(await harness.deliver(quoteId), 202);

      harness.clock.pinned = new Date(boundary);
      expectError(await harness.deliver(quoteId), 409, "invalid_state_transition", { status: "expired" });

      harness.clock.pinned = new Date(boundary + 1);
      expectError(await harness.deliver(quoteId), 409, "invalid_state_transition", { status: "expired" });

      // Materialized expiry (T9): stored `expired`, even with a clock before the boundary.
      const other = await harness.issued();
      await harness.sql(
        `update quote_service.quotes set status = 'expired', expired_at = valid_until_exclusive, version = version + 1, updated_at = now()
         where quote_id = $1`,
        [other.quoteId]
      );
      harness.clock.pinned = new Date(Date.now());
      expectError(await harness.deliver(other.quoteId), 409, "invalid_state_transition", { status: "expired" });

      expect(await harness.counts()).toMatchObject({ deliveries: 1, bindings: 1 });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A delivery request: recipient (Domain §10.2)", () => {
  it(
    "O, P, T, U: explicit recipient and customer fallback are snapshotted; the response is the closed Delivery with the masked address only",
    async () => {
      const harness = await start();
      const { quoteId, pdfSha256 } = await harness.issued();

      const explicit = await harness.deliver(quoteId, { body: { recipient: EXPLICIT } });
      expectPost(explicit, 202);
      expect(Object.keys(explicit.body).sort()).toEqual(DELIVERY_KEYS);
      expect(explicit.body).toMatchObject({
        quoteId,
        channel: "email",
        status: "pending",
        recipientMasked: "ca***@example.com",
        documentSha256: pdfSha256,
        sentAt: null,
        attempts: { count: 0, lastAttemptAt: null, lastErrorCode: null }
      });
      expect(explicit.headers.get("location")).toBe(`/v2/quotes/${quoteId}/deliveries/${explicit.body.deliveryId}`);
      expect(explicit.headers.get("idempotent-replay")).toBeNull();
      expect(explicit.text).not.toContain("camila");
      expect(explicit.text).not.toContain("Rojas");

      const fallback = await harness.deliver(quoteId, { body: {} });
      expectPost(fallback, 202);
      expect(fallback.body.recipientMasked).toBe("co***@andesfit.example.com");
      expect(fallback.text).not.toContain("compras");

      const rows = await harness.deliveryRows(quoteId);
      const byId = new Map(rows.map((row) => [row.delivery_id, row]));
      expect(byId.get(explicit.body.deliveryId)).toMatchObject({
        recipient_email: EXPLICIT.email,
        recipient_name: EXPLICIT.name,
        recipient_masked: "ca***@example.com",
        origin: "v2",
        channel: "email",
        status: "pending",
        generation: "0",
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
        provider_message_id: null,
        last_error_code: null,
        sent_at: null,
        requested_by_principal_id: "clerk"
      });
      const explicitRow = byId.get(explicit.body.deliveryId)!;
      expect(explicitRow.next_attempt_at.getTime()).toBe(explicitRow.requested_at.getTime());
      // Company customer: the contact person's name, never the legal (organization) name.
      expect(byId.get(fallback.body.deliveryId)).toMatchObject({ recipient_email: COMPANY_EMAIL, recipient_name: "Pedro Soto" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "Q: neither a recipient nor a customer email → 422 delivery_recipient_missing; nothing queued or bound",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued(TOKENS.clerk, { kind: "guest" });
      const key = "no-recipient";
      const response = await harness.deliver(quoteId, { key, body: {} });
      expectError(response, 422, "delivery_recipient_missing");
      expect(response.body).toMatchObject({ error: { message: example("error.delivery-recipient-missing.json").error.message } });
      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0 });
      expect((await harness.lookup(key)).body).toMatchObject({ state: "not_found", binding: null });

      // The same key may then be used with an explicit recipient (a 4xx bound nothing).
      expectPost(await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } }), 202);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "R, S: malformed and injection recipients (incl. a>,<victim@evil.com) → 422 validation_error; unknown members rejected",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();

      for (const email of HOSTILE_RECIPIENTS) {
        const response = await harness.deliver(quoteId, { body: { recipient: { email } } });
        expectError(response, 422, "validation_error");
        expect(response.body.error.details.fields[0].path).toBe("/recipient/email");
      }

      const injection = await harness.deliver(quoteId, { body: { recipient: { email: "a>,<victim@evil.com" } } });
      expectError(injection, 422, "validation_error");
      expect(injection.text).not.toContain("victim");

      expectError(await harness.deliver(quoteId, { body: { recipient: EXPLICIT, cc: "x@y.cl" } }), 422, "validation_error");
      expectError(await harness.deliver(quoteId, { body: { recipient: { ...EXPLICIT, bcc: "x@y.cl" } } }), 422, "validation_error");
      expectError(await harness.deliver(quoteId, { body: { recipient: { ...EXPLICIT, name: "Ana\r\nBcc: x@y.cl" } } }), 422, "validation_error");
      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "V: the raw recipient (address and name) appears in no audit event, no GET response and no log line; the raw key is never logged",
    async () => {
      const logs: string[] = [];
      const harness = await start({ logs });
      const { quoteId } = await harness.issued();
      const key = "raw-key-must-not-be-logged-0042";
      const accepted = await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } });
      expectPost(accepted, 202);
      await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } });
      await harness.deliver(quoteId, { body: {} });
      await harness.deliver(quoteId, { body: { recipient: { email: "a>,<victim@evil.com" } } });

      const audit = JSON.stringify(await harness.events(quoteId));
      const read = await harness.getDelivery(quoteId, accepted.body.deliveryId);

      for (const secret of ["camila", "Camila", "Rojas", "compras@", "Pedro Soto", "victim"]) {
        expect(audit, secret).not.toContain(secret);
        expect(read.text, secret).not.toContain(secret);
        expect(logs.join("\n"), secret).not.toContain(secret);
      }

      expect(logs.join("\n")).not.toContain(key);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A delivery request: idempotency (Idempotency §2, §3, §5)", () => {
  it(
    "W, X: same key + same body → 202 replay of the same delivery (no second row or requested event); changed body → 409 conflict",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const key = "replay-key";
      const first = await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } });
      expectPost(first, 202);

      const replay = await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } });
      expectPost(replay, 202);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(replay.headers.get("location")).toBe(first.headers.get("location"));
      expect(replay.body).toEqual(first.body);

      const conflict = await harness.deliver(quoteId, { key, body: { recipient: { email: "otra@example.com" } } });
      expectError(conflict, 409, "idempotency_key_conflict");
      expect(conflict.body.error.details.operation).toBe("quote.delivery.email");

      expect(await harness.counts()).toMatchObject({ deliveries: 1, bindings: 1 });
      const types = (await harness.events(quoteId)).map((event) => event.event_type);
      expect(types.filter((type) => type === "quote.delivery.requested")).toHaveLength(1);
      expect(types.filter((type) => type === "idempotency.replayed")).toHaveLength(1);
      expect(types.filter((type) => type === "idempotency.conflict")).toHaveLength(1);

      const lookup = await harness.lookup(key);
      expect(lookup.body).toMatchObject({
        state: "bound",
        binding: { resourceType: "delivery", quoteId, deliveryId: first.body.deliveryId, operationId: null, quoteStatus: "issued" }
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "Y: 8 concurrent first requests with one key → exactly one delivery, one binding, one requested event; all answer the same delivery",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const key = "concurrent-key";
      const responses = await Promise.all(Array.from({ length: 8 }, () => harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } })));

      for (const response of responses) {
        expectPost(response, 202);
      }

      expect(new Set(responses.map((response) => response.body.deliveryId)).size).toBe(1);
      expect(responses.filter((response) => response.headers.get("idempotent-replay") === "true")).toHaveLength(7);
      expect(await harness.counts()).toMatchObject({ deliveries: 1, bindings: 1, deliveryEvents: 1 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "Z: the same key used by two principals is two independent scopes (two deliveries, no conflict)",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const key = "shared-across-principals";
      const own = await harness.deliver(quoteId, { key, token: TOKENS.clerk, body: { recipient: EXPLICIT } });
      const other = await harness.deliver(quoteId, { key, token: TOKENS.comms, body: {} });
      expectPost(own, 202);
      expectPost(other, 202);
      expect(other.headers.get("idempotent-replay")).toBeNull();
      expect(other.body.deliveryId).not.toBe(own.body.deliveryId);
      expect(await harness.counts()).toMatchObject({ deliveries: 2, bindings: 2 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AA: 404, 409 and 422 rejections bind nothing; the key stays usable",
    async () => {
      const harness = await start();
      const draft = await harness.draft();
      const { quoteId } = await harness.issued();
      const key = "rejected-then-ok";

      expectError(await harness.deliver(UNKNOWN_ID, { key }), 404, "quote_not_found");
      expectError(await harness.deliver(draft.quoteId, { key }), 409, "invalid_state_transition");
      expectError(await harness.deliver(quoteId, { key, body: { recipient: { email: "bad" } } }), 422, "validation_error");
      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0, deliveryEvents: 0 });

      expectPost(await harness.deliver(quoteId, { key }), 202);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AD: a replay answers the delivery's CURRENT state (here failed by a later cancel), never a stored response",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const key = "replay-current";
      const first = await harness.deliver(quoteId, { key });
      expectPost(first, 202);
      expect((await harness.cancel(quoteId, (await harness.quoteRow(quoteId)).version)).status).toBe(200);

      const replay = await harness.deliver(quoteId, { key });
      expectPost(replay, 202);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(replay.body).toMatchObject({ deliveryId: first.body.deliveryId, status: "failed", attempts: { lastErrorCode: "quote_cancelled" } });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A delivery request: provider not configured (Domain §10.1, A6 ordering)", () => {
  it(
    "AB: 503 dependency_unavailable (email_provider), nothing queued, bound or audited — for an otherwise valid request",
    async () => {
      const harness = await start({ mail: false });
      const { quoteId } = await harness.issued();
      const key = "disabled-provider";
      const before = await harness.events(quoteId);
      const response = await harness.deliver(quoteId, { key, body: { recipient: EXPLICIT } });
      expectError(response, 503, "dependency_unavailable", { dependency: "email_provider", retryable: false });
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0, deliveryEvents: 0 });
      expect(await harness.events(quoteId)).toEqual(before);
      expect((await harness.lookup(key)).body).toMatchObject({ state: "not_found" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "the provider check precedes visibility, body and state checks (they need a configured provider)",
    async () => {
      const harness = await start({ mail: false });
      const draft = await harness.draft();
      expectError(await harness.deliver(UNKNOWN_ID), 503, "dependency_unavailable");
      expectError(await harness.deliver(draft.quoteId), 503, "dependency_unavailable");
      expectError(await harness.deliver(draft.quoteId, { body: { recipient: { email: "bad" } } }), 503, "dependency_unavailable");
      // ...but never precedes 401/403.
      expectError(await harness.deliver(draft.quoteId, { token: TOKENS.backoffice }), 403, "forbidden");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AC: a key bound while the provider was configured replays (202, same delivery) after it is disabled; a new key → 503 and no state",
    async () => {
      const enabled = await start({ mail: true });
      const { quoteId } = await enabled.issued();
      const bound = await enabled.deliver(quoteId, { key: "K", body: { recipient: EXPLICIT } });
      expectPost(bound, 202);

      const disabled = await start({ mail: false, databaseUrl: enabled.connectionString });
      const replay = await disabled.deliver(quoteId, { key: "K", body: { recipient: EXPLICIT } });
      expectPost(replay, 202);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(replay.body.deliveryId).toBe(bound.body.deliveryId);

      // A conflicting body under the bound key is still a conflict (binding before provider).
      expectError(await disabled.deliver(quoteId, { key: "K", body: {} }), 409, "idempotency_key_conflict");

      expectError(await disabled.deliver(quoteId, { key: "K2", body: { recipient: EXPLICIT } }), 503, "dependency_unavailable", {
        dependency: "email_provider",
        retryable: false
      });
      expect(await disabled.counts()).toMatchObject({ deliveries: 1, bindings: 1, deliveryEvents: 1 });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A delivery request: pinned document, no side effects on the quote (Domain §9, §10.2)", () => {
  it(
    "AE–AI: documentSha256 = committed manifest hash; no render, no storage read/write, no new document; quote row and audit state unchanged",
    async () => {
      const harness = await start();
      const { quoteId, pdfSha256 } = await harness.issued();
      const quoteBefore = await harness.quoteRow(quoteId);
      const documentsBefore = await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [quoteId]);
      const countsBefore = await harness.counts();
      harness.renderSpy.mockClear();
      harness.publishSpy.mockClear();
      harness.readSpy.mockClear();

      const response = await harness.deliver(quoteId, { body: { recipient: EXPLICIT } });
      expectPost(response, 202);
      expect(response.body.documentSha256).toBe(pdfSha256);
      expect((await harness.deliveryRows(quoteId))[0]!.document_sha256).toBe(pdfSha256);

      expect(harness.renderSpy).not.toHaveBeenCalled();
      expect(harness.publishSpy).not.toHaveBeenCalled();
      expect(harness.readSpy).not.toHaveBeenCalled();
      expect((await harness.counts()).documents).toBe(countsBefore.documents);
      expect(await harness.sql(`select * from quote_service.quote_documents where quote_id = $1`, [quoteId])).toEqual(documentsBefore);
      expect(await harness.quoteRow(quoteId)).toEqual(quoteBefore);

      const quote = await harness.call("GET", `/v2/quotes/${quoteId}`);
      expect(quote.body).toMatchObject({ status: "issued", version: quoteBefore.version, document: { pdfSha256 } });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "requested audit event: requester, key hash, correlation, no quote transition, data = {deliveryId, documentSha256} only",
    async () => {
      const harness = await start();
      const { quoteId, pdfSha256 } = await harness.issued();
      const key = "audit-key";
      const response = await harness.call("POST", `/v2/quotes/${quoteId}/deliveries/email`, { key, body: { recipient: EXPLICIT } });
      expectPost(response, 202);
      const requested = (await harness.events(quoteId)).filter((event) => event.event_type === "quote.delivery.requested");
      expect(requested).toEqual([
        {
          event_type: "quote.delivery.requested",
          principal_id: "clerk",
          operation_id: null,
          correlation_id: null,
          idempotency_key_hash: sha256Hex(key),
          from_status: null,
          to_status: null,
          data: { deliveryId: response.body.deliveryId, documentSha256: pdfSha256 }
        }
      ]);

      const audit = await harness.call("GET", `/v2/quotes/${quoteId}/audit`);
      expect(audit.status).toBe(200);
      expect(responseErrors("/v2/quotes/{quoteId}/audit", "get", 200, audit.body)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A GET delivery (openapi getDelivery)", () => {
  it(
    "200 for a visible quote's delivery (creator or read:any); 404 delivery_not_found for unknown or another quote's delivery; 404 quote_not_found when not visible; 403 without quotes:read",
    async () => {
      const harness = await start();
      const first = await harness.issued();
      const second = await harness.issued();
      const delivery = (await harness.deliver(first.quoteId, { body: { recipient: EXPLICIT } })).body;

      const own = await harness.getDelivery(first.quoteId, delivery.deliveryId);
      expectGet(own, 200);
      expect(own.body).toEqual(delivery);
      expect(Object.keys(own.body).sort()).toEqual(DELIVERY_KEYS);
      expect(schemaErrors("Delivery", own.body)).toEqual([]);

      expectGet(await harness.getDelivery(first.quoteId, delivery.deliveryId, TOKENS.operatorRead), 200);
      expectGet(await harness.getDelivery(first.quoteId, delivery.deliveryId, TOKENS.comms), 200);

      const unknown = await harness.getDelivery(first.quoteId, UNKNOWN_ID);
      expectGet(unknown, 404);
      expect(unknown.body.error.code).toBe("delivery_not_found");

      const otherQuote = await harness.getDelivery(second.quoteId, delivery.deliveryId);
      expectGet(otherQuote, 404);
      expect(otherQuote.body.error.code).toBe("delivery_not_found");

      const hidden = await harness.getDelivery(first.quoteId, delivery.deliveryId, TOKENS.clerk2);
      expectGet(hidden, 404);
      expect(hidden.body.error.code).toBe("quote_not_found");

      const forbidden = await harness.getDelivery(first.quoteId, delivery.deliveryId, TOKENS.senderOnly);
      expectGet(forbidden, 403);
      expect(forbidden.body.error.details).toEqual({ requiredScope: "quotes:read" });

      const badId = await harness.getDelivery(first.quoteId, "not-a-uuid");
      expectGet(badId, 400);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "there is no delivery list endpoint and the quote representation embeds no delivery",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      expectPost(await harness.deliver(quoteId), 202);
      expect((await harness.call("GET", `/v2/quotes/${quoteId}/deliveries`)).status).toBe(404);
      const quote = await harness.call("GET", `/v2/quotes/${quoteId}`);
      expect(quote.text).not.toMatch(/deliver/i);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A T8: cancelling an issued quote fails its pending deliveries, with one audit event each", () => {
  async function cancelledWithDeliveries(harness: Harness, count: number) {
    const { quoteId } = await harness.issued();
    const deliveries: string[] = [];

    for (let index = 0; index < count; index += 1) {
      deliveries.push((await harness.deliver(quoteId, { body: { recipient: EXPLICIT } })).body.deliveryId);
    }

    const before = await harness.quoteRow(quoteId);
    const cancel = await harness.cancel(quoteId, before.version, { key: "cancel-key" });
    expect(cancel.status).toBe(200);
    return { quoteId, deliveries, before };
  }

  it(
    "AJ, AK, AN: one pending delivery → failed (quote_cancelled) + exactly one quote.delivery.failed with ids and code only",
    async () => {
      const harness = await start();
      const { quoteId, deliveries, before } = await cancelledWithDeliveries(harness, 1);

      expect(await harness.deliveryRows(quoteId)).toMatchObject([{ delivery_id: deliveries[0], status: "failed", last_error_code: "quote_cancelled" }]);
      const events = await harness.events(quoteId);
      const failed = events.filter((event) => event.event_type === "quote.delivery.failed");
      expect(failed).toEqual([
        {
          event_type: "quote.delivery.failed",
          principal_id: "clerk",
          operation_id: null,
          correlation_id: null,
          idempotency_key_hash: sha256Hex("cancel-key"),
          from_status: null,
          to_status: null,
          data: { deliveryId: deliveries[0], errorCode: "quote_cancelled" }
        }
      ]);
      // The delivery events follow the cancel event they belong to.
      const types = events.map((event) => event.event_type);
      expect(types.indexOf("quote.cancelled")).toBeLessThan(types.indexOf("quote.delivery.failed"));
      expect(JSON.stringify(failed)).not.toMatch(/camila|Rojas|@/);

      // The delivery changed nothing else: the quote moved exactly once (the cancel itself).
      const after = await harness.quoteRow(quoteId);
      expect(after).toMatchObject({ status: "cancelled", version: before.version + 1 });

      const read = await harness.getDelivery(quoteId, deliveries[0]!);
      expectGet(read, 200);
      expect(read.body).toMatchObject({ status: "failed", attempts: { count: 0, lastErrorCode: "quote_cancelled" } });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AL, AM: several pending deliveries each get exactly one event; a replayed cancel adds none and a new cancel is rejected",
    async () => {
      const harness = await start();
      const { quoteId, deliveries } = await cancelledWithDeliveries(harness, 3);
      const failedEvents = async () => (await harness.events(quoteId)).filter((event) => event.event_type === "quote.delivery.failed");

      expect((await failedEvents()).map((event) => event.data.deliveryId).sort()).toEqual([...deliveries].sort());

      const version = (await harness.quoteRow(quoteId)).version;
      const replay = await harness.cancel(quoteId, version - 1, { key: "cancel-key" });
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect((await harness.cancel(quoteId, version, { key: "another-cancel" })).status).toBe(409);
      expect(await failedEvents()).toHaveLength(3);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a delivery that already left `pending` is not touched by T8 (only not-yet-sending deliveries fail)",
    async () => {
      const harness = await start();
      const { quoteId } = await harness.issued();
      const pending = (await harness.deliver(quoteId)).body.deliveryId;
      const sending = (await harness.deliver(quoteId)).body.deliveryId;
      // Simulated R1.6B claim (schema: sending ⇔ lease).
      await harness.sql(
        `update quote_service.quote_deliveries set status = 'sending', generation = 1, lease_owner = 'test-worker',
                lease_expires_at = now() + interval '1 minute', attempt_count = 1, last_attempt_at = now(), next_attempt_at = null
         where delivery_id = $1`,
        [sending]
      );
      expect((await harness.cancel(quoteId, (await harness.quoteRow(quoteId)).version)).status).toBe(200);

      const rows = new Map((await harness.deliveryRows(quoteId)).map((row) => [row.delivery_id, row.status]));
      expect(rows.get(pending)).toBe("failed");
      expect(rows.get(sending)).toBe("sending");
      const failed = (await harness.events(quoteId)).filter((event) => event.event_type === "quote.delivery.failed");
      expect(failed.map((event) => event.data.deliveryId)).toEqual([pending]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a draft cancel (T7) and a cancel after failed issuance (T11) touch no delivery and write no delivery event",
    async () => {
      const harness = await start();
      const draft = await harness.draft();
      expect((await harness.cancel(draft.quoteId, 1)).status).toBe(200);
      const failed = await harness.issuing();
      await harness.markOperationFailed(failed.operationId);
      expect((await harness.cancel(failed.quoteId, (await harness.quoteRow(failed.quoteId)).version)).status).toBe(200);
      expect(await harness.counts()).toMatchObject({ deliveries: 0, deliveryEvents: 0 });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A cancel/delivery race: the quote row lock serializes them", () => {
  it(
    "concurrent delivery requests and a cancel never leave a pending delivery on a cancelled quote",
    async () => {
      const harness = await start();

      for (let round = 0; round < 3; round += 1) {
        const { quoteId } = await harness.issued();
        const version = (await harness.quoteRow(quoteId)).version;
        const results = await Promise.all([
          harness.deliver(quoteId),
          harness.deliver(quoteId),
          harness.cancel(quoteId, version),
          harness.deliver(quoteId),
          harness.deliver(quoteId)
        ]);

        for (const [index, response] of results.entries()) {
          expect([200, 202, 409], `${index}: ${response.text}`).toContain(response.status);
        }

        const rows = await harness.deliveryRows(quoteId);
        expect(rows.filter((row) => row.status === "pending")).toEqual([]);
        const failedEvents = (await harness.events(quoteId)).filter((event) => event.event_type === "quote.delivery.failed");
        expect(failedEvents).toHaveLength(rows.length);
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6A no email (D-3)", () => {
  it(
    "AP, AQ, AR: a real issuance creates zero deliveries; a request, a replay and a cancel never send; the spy is never called",
    async () => {
      const harness = await start({ issuance: true });
      const created = await harness.call("POST", "/v2/quotes", {
        token: TOKENS.sales,
        key: "real-issue",
        body: example("create-and-issue.request.json")
      });
      expect([201, 202]).toContain(created.status);
      const quoteId = created.body.quote.quoteId as string;
      await waitFor(async () => (await harness.quoteRow(quoteId)).status === "issued", 30_000, 100);
      expect(await harness.counts()).toMatchObject({ deliveries: 0, bindings: 0, deliveryEvents: 0 });

      const [manifest] = await harness.sql(`select pdf_sha256 from quote_service.quote_documents where quote_id = $1`, [quoteId]);
      const renderCalls = harness.renderSpy.mock.calls.length;

      // The sales integration profile has no delivery scope; the customer-communication profile does (read:any).
      expectError(await harness.deliver(quoteId, { token: TOKENS.sales }), 403, "forbidden");
      const queued = await harness.deliver(quoteId, { token: TOKENS.comms, key: "comms-1", body: {} });
      expectPost(queued, 202);
      expect(queued.body.documentSha256).toBe(manifest!.pdf_sha256);
      expectPost(await harness.deliver(quoteId, { token: TOKENS.comms, key: "comms-1", body: {} }), 202);
      expect(harness.renderSpy.mock.calls.length).toBe(renderCalls);

      // No delivery worker exists in R1.6A: the queued delivery stays pending, unattempted.
      expect(await harness.deliveryRows(quoteId)).toMatchObject([{ status: "pending", attempt_count: 0, provider_message_id: null }]);
      expect(sent).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});
