/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import type { MailSenderPort, MailSendOutcome, OutboundMail } from "../../src/application/quote-v2/delivery/mail-sender-port";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { GmailMailSender } from "../../src/infrastructure/email/gmail-mail-sender";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { databaseClock, type QuoteClock } from "../../src/infrastructure/persistence/postgres/quote-clock";
import { PostgresDeliveryRepository } from "../../src/infrastructure/persistence/postgres/quote-v2-delivery-execution";
import { responseErrors } from "../helpers/openapi-contract";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS as SHARED_TOKENS, testRegistryDocument } from "../helpers/test-principals";

/*
 * R1.6B — V2 email delivery EXECUTION on real PostgreSQL: claim, A6.1
 * eligibility, verified attachment, fenced completion, W9 retries, the
 * expired-`sending` sweep, cancellation and sweep races, email health and
 * queue metrics, and log/audit redaction. Every provider is a local fake
 * (an in-process MailSenderPort, or the real Gmail adapter pointed at a
 * loopback HTTP server). Nothing reaches Gmail or the internet.
 *
 * The periodic runners are slowed to 60 s so each test drives the worker
 * (`delivery.worker.tick()`) and the sweep (`deliveryOutcomeSweep.runNow()`)
 * explicitly. Lease expiry is simulated by moving `lease_expires_at` into
 * the past, which is exactly what time would do.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 90_000;
const LEASE_MS = 15_000;
const TOKENS = { ...SHARED_TOKENS, clerk: "test-delivery-exec-clerk-token-0123456789abcdefghijklmnop" };
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 60_000);

function registry(): PrincipalRegistry {
  const document = testRegistryDocument();
  document.principals.push({
    principalId: "clerk",
    principalType: "operator",
    scopes: ["quotes:create", "quotes:draft:write", "quotes:issue", "quotes:read", "quotes:cancel", "quotes:audit:read", "quotes:delivery:email", "quotes:document:read"],
    tokenSha256: [sha256Hex(TOKENS.clerk)]
  });
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}

class TestClock implements QuoteClock {
  pinned: Date | null = null;

  now(queryable: Parameters<QuoteClock["now"]>[0]): Promise<Date> {
    return this.pinned ? Promise.resolve(this.pinned) : databaseClock.now(queryable);
  }
}

type Scripted = MailSendOutcome | ((mail: OutboundMail) => Promise<MailSendOutcome>);

/** In-process fake provider: records every call and answers from a script (default: accepted). */
class FakeSender implements MailSenderPort {
  readonly calls: OutboundMail[] = [];
  readonly script: Scripted[] = [];
  fallback: MailSendOutcome = { kind: "accepted", providerMessageId: "fake-provider-id" };

  async send(mail: OutboundMail): Promise<MailSendOutcome> {
    this.calls.push(mail);
    const next = this.script.shift() ?? this.fallback;
    return typeof next === "function" ? next(mail) : next;
  }
}

const ACCEPTED = (id: string | null = "provider-msg-1"): MailSendOutcome => ({ kind: "accepted", providerMessageId: id });
const RETRYABLE = (code = "email_rate_limited"): MailSendOutcome => ({ kind: "not_accepted", retryable: true, code: code as never });
const PERMANENT: MailSendOutcome = { kind: "not_accepted", retryable: false, code: "email_provider_rejected" };
const AMBIGUOUS: MailSendOutcome = { kind: "ambiguous", code: "email_outcome_unknown" };

interface StartOptions {
  sender?: MailSenderPort | null;
  databaseUrl?: string;
  storageRoot?: string;
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

  let storageRoot = options.storageRoot;

  if (!storageRoot) {
    storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-delivery-exec-"));
    const root = storageRoot;
    cleanups.push(() => fsPromises.rm(root, { recursive: true, force: true }));
  }

  const sender = options.sender === undefined ? new FakeSender() : options.sender;
  const clock = new TestClock();
  const context: ApplicationContext = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: connectionString,
      storageRoot,
      overrides: {
        LOG_LEVEL: options.logs ? "trace" : "silent",
        QUOTE_EMAIL_DELIVERY_LEASE_MS: String(LEASE_MS),
        QUOTE_EMAIL_POLL_INTERVAL_MS: "60000",
        QUOTE_EMAIL_TOKEN_TIMEOUT_MS: "1000",
        QUOTE_EMAIL_SEND_TIMEOUT_MS: "2000",
        QUOTE_ISSUANCE_SYNC_BUDGET_MS: "10000"
      }
    }),
    {
      principalRegistry: registry(),
      quoteClock: clock,
      ...(options.issuance ? {} : { disableIssuanceExecution: true }),
      ...(sender ? { testMailSender: sender } : {}),
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {})
    }
  );
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const renderSpy = vi.spyOn(context.pdfRenderer, "renderPdf");
  const readSpy = vi.spyOn(context.artifactStorage, "readVerified");
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  await waitFor(async () => (await fetch(`${baseUrl}/health/ready`)).status === 200, 30_000, 50);
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;

  async function call(method: string, pathname: string, input: { token?: string; key?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Authorization: bearer(input.token ?? TOKENS.clerk) };

    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (input.key) {
      headers["Idempotency-Key"] = input.key;
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
    const isPdf = (response.headers.get("content-type") ?? "").startsWith("application/pdf");
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, body: (isPdf || bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8"))) as AnyRecord };
  }

  const harness = {
    context,
    sender: sender as FakeSender,
    clock,
    sql,
    call,
    baseUrl,
    storageRoot,
    connectionString,
    renderSpy,
    readSpy,
    worker: () => context.delivery!.worker!,
    tick: () => context.delivery!.worker!.tick(),
    sweep: () => context.delivery!.deliveryOutcomeSweep.runNow(),
    repository: () => new PostgresDeliveryRepository(context.database, { leaseMs: LEASE_MS, clock }),

    /** Issued quote with a REAL committed artifact: published to the content-addressed store, manifest committed like T5. */
    async issued(input: { customer?: AnyRecord; pdf?: Buffer } = {}): Promise<{ quoteId: string; pdfSha256: string; pdf: Buffer; storageKey: string }> {
      const body = example("draft-create.request.json");
      const draft = await call("POST", "/v2/quotes/drafts", { key: `draft-${crypto.randomUUID()}`, body: input.customer ? { ...body, customer: input.customer } : body });
      expect(draft.status).toBe(201);
      const quoteId = draft.body.quoteId as string;
      const issuing = await call("POST", `/v2/quotes/${quoteId}/issue`, { key: `issue-${crypto.randomUUID()}`, body: { expectedVersion: 1 } });
      expect(issuing.status).toBe(202);
      const operationId = issuing.body.operation.operationId as string;
      const pdf = input.pdf ?? Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(2048), Buffer.from("\n%%EOF\n")]);
      const published = await context.artifactStorage.publish(pdf);
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
         ) select $1, $2, o.operation_id, 'issuance', 'application/pdf', o.snapshot_hash, 'jcs-sha256-v2', $3, $4,
                  'quote-pdf-v4', 'quote-template-v4', now(), $5, now()
           from quote_service.issuance_operations o where o.operation_id = $6`,
        [crypto.randomUUID(), quoteId, published.pdfSha256, published.byteLength, published.storageKey, operationId]
      );
      await admin.query(`update quote_service.quotes set status = 'issued', version = version + 1, updated_at = now() where quote_id = $1`, [quoteId]);
      await admin.query("commit");
      return { quoteId, pdfSha256: published.pdfSha256, pdf, storageKey: published.storageKey };
    },

    async request(quoteId: string, body: AnyRecord = {}, key = `delivery-${crypto.randomUUID()}`) {
      return call("POST", `/v2/quotes/${quoteId}/deliveries/email`, { key, body });
    },
    async requested(quoteId: string, body: AnyRecord = {}): Promise<string> {
      const response = await harness.request(quoteId, body);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      return response.body.deliveryId as string;
    },
    async row(deliveryId: string): Promise<AnyRecord> {
      return (await sql(`select *, generation::int as generation from quote_service.quote_deliveries where delivery_id = $1`, [deliveryId]))[0]!;
    },
    async quote(quoteId: string): Promise<AnyRecord> {
      return (await sql(`select status, version, updated_at from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    async deliveryEvents(quoteId: string): Promise<AnyRecord[]> {
      return sql(
        `select event_type, principal_id, operation_id, correlation_id, idempotency_key_hash, from_status, to_status, data
         from quote_service.quote_audit_events where quote_id = $1 and event_type like 'quote.delivery.%' order by sequence`,
        [quoteId]
      );
    },
    makeDue: (deliveryId: string) => sql(`update quote_service.quote_deliveries set next_attempt_at = clock_timestamp() where delivery_id = $1 and status = 'pending'`, [deliveryId]),
    expireLease: (deliveryId: string) =>
      sql(`update quote_service.quote_deliveries set lease_expires_at = clock_timestamp() - interval '1 second' where delivery_id = $1 and status = 'sending'`, [deliveryId]),
    async health(): Promise<AnyRecord> {
      const response = await call("GET", "/health/dependencies", { token: TOKENS.monitoring });
      expect(response.status).toBe(200);
      expect(responseErrors("/health/dependencies", "get", 200, response.body)).toEqual([]);
      return response.body;
    }
  };

  return harness;
}

type Harness = Awaited<ReturnType<typeof start>>;

async function expectQuoteUnchanged(harness: Harness, quoteId: string, before: AnyRecord): Promise<void> {
  expect(await harness.quote(quoteId)).toEqual(before);
}

describe("R1.6B worker states (AC–AS)", () => {
  it(
    "AC/AD/AN: only due `pending` rows are claimed; a claim sets sending, generation+1, a unique lease, attempt+1; future and terminal rows never",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const due = await h.requested(quoteId);
      const future = await h.requested(quoteId);
      await h.sql(`update quote_service.quote_deliveries set next_attempt_at = clock_timestamp() + interval '1 hour' where delivery_id = $1`, [future]);
      const repository = h.repository();

      const claim = await repository.claimNext("owner-a:1:x");
      expect(claim.kind).toBe("CLAIMED");
      expect(claim.kind === "CLAIMED" && claim.delivery.deliveryId).toBe(due);
      const row = await h.row(due);
      expect(row).toMatchObject({ status: "sending", generation: 1, attempt_count: 1, lease_owner: "owner-a:1:x", next_attempt_at: null });
      expect(new Date(row.lease_expires_at).getTime() - new Date(row.last_attempt_at).getTime()).toBe(LEASE_MS);

      // The other row is not due; the sending row is never claimed again.
      expect(await repository.claimNext("owner-b:2:y")).toEqual({ kind: "NONE_AVAILABLE" });

      for (const status of ["sent", "failed", "unknown"]) {
        const id = await h.requested(quoteId);
        await h.sql(
          `update quote_service.quote_deliveries set status = $2, last_error_code = 'x_y', sent_at = case when $2 = 'sent' then now() end where delivery_id = $1`,
          [id, status]
        );
      }

      expect(await repository.claimNext("owner-b:2:y")).toEqual({ kind: "NONE_AVAILABLE" });
      expect((await h.row(future)).status).toBe("pending");
      expect(h.sender.calls).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AE: two workers race for one due delivery ×10 → exactly one claim each time",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const a = h.repository();
      const b = h.repository();

      for (let round = 0; round < 10; round += 1) {
        const id = await h.requested(quoteId);
        const results = await Promise.all([a.claimNext(`a:${round}`), b.claimNext(`b:${round}`)]);
        expect(results.filter((result) => result.kind === "CLAIMED")).toHaveLength(1);
        expect((await h.row(id)).generation).toBe(1);
        await h.sql(`update quote_service.quote_deliveries set status = 'unknown', lease_owner = null, lease_expires_at = null, last_error_code = 'x_y' where delivery_id = $1`, [id]);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AF/AG/AS: quote expired or cancelled before claim → failed (quote_expired / quote_cancelled), provider never called, quote untouched",
    async () => {
      const h = await start();
      const expired = await h.issued();
      const expiredDelivery = await h.requested(expired.quoteId);
      const expiredBefore = await h.quote(expired.quoteId);
      const { valid_until_exclusive: boundary } = (await h.sql(`select valid_until_exclusive from quote_service.quotes where quote_id = $1`, [expired.quoteId]))[0]!;
      h.clock.pinned = new Date(boundary); // exactly at the boundary: expired

      expect(await h.tick()).toBe(1);
      expect(await h.row(expiredDelivery)).toMatchObject({ status: "failed", last_error_code: "quote_expired", attempt_count: 0, next_attempt_at: null, lease_owner: null });
      await expectQuoteUnchanged(h, expired.quoteId, expiredBefore);
      h.clock.pinned = null;

      // A cancelled quote that still has a pending delivery (T8 normally fails it; here one slipped past it).
      const cancelled = await h.issued();
      const version = (await h.quote(cancelled.quoteId)).version as number;
      const cancel = await h.call("POST", `/v2/quotes/${cancelled.quoteId}/cancel`, { key: `cancel-${crypto.randomUUID()}`, body: { expectedVersion: version, reasonCode: "customer_declined" } });
      expect(cancel.status).toBe(200);
      const cancelledBefore = await h.quote(cancelled.quoteId);
      const { pdf_sha256: pdfSha256 } = (await h.sql(`select pdf_sha256 from quote_service.quote_documents where quote_id = $1`, [cancelled.quoteId]))[0]!;
      const orphan = crypto.randomUUID();
      await h.sql(
        `insert into quote_service.quote_deliveries (delivery_id, quote_id, origin, channel, status, recipient_email, recipient_masked, document_sha256,
           requested_by_principal_id, generation, attempt_count, next_attempt_at, requested_at, updated_at)
         values ($1, $2, 'v2', 'email', 'pending', 'x@example.com', 'x***@example.com', $3, 'clerk', 0, 0, now(), now(), now())`,
        [orphan, cancelled.quoteId, pdfSha256]
      );

      expect(await h.tick()).toBe(1);
      expect(await h.row(orphan)).toMatchObject({ status: "failed", last_error_code: "quote_cancelled", attempt_count: 0 });
      await expectQuoteUnchanged(h, cancelled.quoteId, cancelledBefore);
      expect(h.sender.calls).toHaveLength(0);
      expect(h.readSpy).not.toHaveBeenCalled();

      const events = await h.deliveryEvents(expired.quoteId);
      expect(events.at(-1)).toEqual({
        event_type: "quote.delivery.failed",
        principal_id: "system",
        operation_id: null,
        correlation_id: null,
        idempotency_key_hash: null,
        from_status: null,
        to_status: null,
        data: { deliveryId: expiredDelivery, documentSha256: expired.pdfSha256, attemptCount: 0, errorCode: "quote_expired" }
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AH/AI/AR/AS/AT/AU/AV: accepted → sent once with the exact committed bytes; null provider id accepted; audit exact; quote unchanged; nothing rendered",
    async () => {
      const h = await start();
      const { quoteId, pdfSha256, pdf } = await h.issued();
      const before = await h.quote(quoteId);
      const first = await h.requested(quoteId, { recipient: { email: "camila.rojas@example.com", name: "Camila Rojas" } });
      h.sender.script.push(ACCEPTED("18c2f0a1b2c3d4e5"));

      expect(await h.tick()).toBe(1);
      const sent = await h.row(first);
      expect(sent).toMatchObject({ status: "sent", provider_message_id: "18c2f0a1b2c3d4e5", attempt_count: 1, generation: 1, lease_owner: null, lease_expires_at: null, next_attempt_at: null, last_error_code: null });
      expect(sent.sent_at).not.toBeNull();

      expect(h.sender.calls).toHaveLength(1);
      const mail = h.sender.calls[0]!;
      expect(mail.deliveryId).toBe(first);
      expect(mail.to).toBe("camila.rojas@example.com");
      expect(mail.subject).toMatch(/^Cotización Pesas Chile PC-\d{6}$/);
      expect(mail.html).toContain("Hola Camila Rojas,");
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments[0]!.contentType).toBe("application/pdf");
      expect(mail.attachments[0]!.filename).toMatch(/^PC-\d{6}\.pdf$/);
      expect(mail.attachments[0]!.content.equals(pdf)).toBe(true);
      expect(sha256(mail.attachments[0]!.content)).toBe(pdfSha256);
      expect(h.renderSpy).not.toHaveBeenCalled();

      const second = await h.requested(quoteId);
      h.sender.script.push(ACCEPTED(null));
      await h.tick();
      expect(await h.row(second)).toMatchObject({ status: "sent", provider_message_id: null });

      const events = await h.deliveryEvents(quoteId);
      expect(events.filter((event) => event.event_type === "quote.delivery.sent")).toEqual(
        [first, second].map((deliveryId) => ({
          event_type: "quote.delivery.sent",
          principal_id: "system",
          operation_id: null,
          correlation_id: null,
          idempotency_key_hash: null,
          from_status: null,
          to_status: null,
          data: { deliveryId, documentSha256: pdfSha256, attemptCount: 1 }
        }))
      );
      await expectQuoteUnchanged(h, quoteId, before);

      // A sent delivery is never sent again.
      await h.tick();
      expect(h.sender.calls).toHaveLength(2);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AJ/AL/AM/BG/BH: retryable → pending at DB now + 1 m (no audit); permanent → failed; ambiguous → unknown; terminal rows have no next attempt",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const retry = await h.requested(quoteId);
      h.sender.script.push(RETRYABLE("email_rate_limited"));
      await h.tick();
      const pending = await h.row(retry);
      expect(pending).toMatchObject({ status: "pending", last_error_code: "email_rate_limited", attempt_count: 1, generation: 1, lease_owner: null, lease_expires_at: null });
      expect(new Date(pending.next_attempt_at).getTime() - new Date(pending.updated_at).getTime()).toBe(60_000);
      expect((await h.deliveryEvents(quoteId)).map((event) => event.event_type)).toEqual(["quote.delivery.requested"]);

      const permanent = await h.requested(quoteId);
      h.sender.script.push(PERMANENT);
      await h.tick();
      expect(await h.row(permanent)).toMatchObject({ status: "failed", last_error_code: "email_provider_rejected", next_attempt_at: null, lease_owner: null });

      const ambiguous = await h.requested(quoteId);
      h.sender.script.push(AMBIGUOUS);
      await h.tick();
      expect(await h.row(ambiguous)).toMatchObject({ status: "unknown", last_error_code: "email_outcome_unknown", next_attempt_at: null, lease_owner: null });

      // Neither terminal row is ever claimed again; the retry only when due.
      await h.tick();
      expect(h.sender.calls).toHaveLength(3);
      await h.makeDue(retry);
      await h.tick();
      expect(h.sender.calls).toHaveLength(4);
      expect(await h.row(retry)).toMatchObject({ status: "sent", attempt_count: 2, generation: 2 });

      const types = (await h.deliveryEvents(quoteId)).map((event) => [event.event_type, event.data.deliveryId, event.data.errorCode ?? null]);
      expect(types.filter(([type]) => type !== "quote.delivery.requested")).toEqual([
        ["quote.delivery.failed", permanent, "email_provider_rejected"],
        ["quote.delivery.unknown", ambiguous, "email_outcome_unknown"],
        ["quote.delivery.sent", retry, null]
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AK/BB/BC: six safe failures → failed with the last real code; delays 1 m, 5 m, 15 m, 1 h, 4 h measured on the database",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const id = await h.requested(quoteId);
      const delays: number[] = [];
      h.sender.fallback = RETRYABLE("email_provider_unavailable");

      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await h.makeDue(id);
        await h.tick();
        const row = await h.row(id);
        expect(row.attempt_count).toBe(attempt);

        if (attempt < 6) {
          expect(row.status).toBe("pending");
          delays.push(new Date(row.next_attempt_at).getTime() - new Date(row.updated_at).getTime());
        } else {
          expect(row).toMatchObject({ status: "failed", last_error_code: "email_provider_unavailable", next_attempt_at: null });
        }
      }

      expect(delays).toEqual([60_000, 300_000, 900_000, 3_600_000, 14_400_000]);
      expect(h.sender.calls).toHaveLength(6);
      await h.tick();
      expect(h.sender.calls).toHaveLength(6);
      const failed = (await h.deliveryEvents(quoteId)).filter((event) => event.event_type === "quote.delivery.failed");
      expect(failed.map((event) => event.data)).toEqual([{ deliveryId: id, documentSha256: expect.any(String), attemptCount: 6, errorCode: "email_provider_unavailable" }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BD: no retry is scheduled past requested_at + 24 h",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const id = await h.requested(quoteId);
      await h.sql(`update quote_service.quote_deliveries set requested_at = clock_timestamp() - interval '23 hours 59 minutes 30 seconds' where delivery_id = $1`, [id]);
      h.sender.script.push(RETRYABLE("email_authentication_failed"));
      await h.tick();
      expect(await h.row(id)).toMatchObject({ status: "failed", last_error_code: "email_authentication_failed", attempt_count: 1 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AO/AP/AQ/AS: an expired `sending` lease → unknown (generation+1, delivery_outcome_unknown); never resent; the late completion is fenced",
    async () => {
      const h = await start();
      const { quoteId, pdfSha256 } = await h.issued();
      const before = await h.quote(quoteId);
      const id = await h.requested(quoteId);
      const repository = h.repository();
      const claim = await repository.claimNext("zombie:1:z");
      expect(claim.kind).toBe("CLAIMED");
      await h.expireLease(id);

      await h.sweep();
      expect(await h.row(id)).toMatchObject({ status: "unknown", generation: 2, lease_owner: null, lease_expires_at: null, last_error_code: "delivery_outcome_unknown", attempt_count: 1 });

      // The zombie reports acceptance afterwards: zero effect.
      const late = await repository.complete(claim.kind === "CLAIMED" ? claim.delivery : (null as never), ACCEPTED("late-id"));
      expect(late).toEqual({ kind: "STALE", currentStatus: "unknown" });
      expect(await h.row(id)).toMatchObject({ status: "unknown", provider_message_id: null, sent_at: null, generation: 2 });

      // Never claimed or sent again, by any worker.
      await h.tick();
      await h.sweep();
      expect(h.sender.calls).toHaveLength(0);
      const unknown = (await h.deliveryEvents(quoteId)).filter((event) => event.event_type === "quote.delivery.unknown");
      expect(unknown.map((event) => [event.principal_id, event.data])).toEqual([["system", { deliveryId: id, documentSha256: pdfSha256, attemptCount: 1, errorCode: "delivery_outcome_unknown" }]]);
      await expectQuoteUnchanged(h, quoteId, before);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B verified attachment (AW–BA)", () => {
  it(
    "AX/AY/AZ/BA: missing or corrupt PDF → no provider call, document_storage_failed, retried safely, then failed at exhaustion; never re-rendered",
    async () => {
      const logs: string[] = [];
      const h = await start({ logs });
      const missing = await h.issued();
      const missingId = await h.requested(missing.quoteId);
      await fsPromises.rm(path.join(h.storageRoot, ...missing.storageKey.split("/")), { force: true });

      await h.tick();
      expect(await h.row(missingId)).toMatchObject({ status: "pending", last_error_code: "document_storage_failed", attempt_count: 1 });

      const corrupt = await h.issued();
      const corruptId = await h.requested(corrupt.quoteId);
      const file = path.join(h.storageRoot, ...corrupt.storageKey.split("/"));
      await fsPromises.chmod(file, 0o644);
      const flipped = Buffer.from(corrupt.pdf);
      flipped[20] = flipped[20]! ^ 0xff;
      await fsPromises.writeFile(file, flipped);

      await h.tick();
      expect(await h.row(corruptId)).toMatchObject({ status: "pending", last_error_code: "document_storage_failed" });

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        await h.makeDue(missingId);
        await h.tick();
      }

      expect(await h.row(missingId)).toMatchObject({ status: "failed", last_error_code: "document_storage_failed", attempt_count: 6 });
      expect(h.sender.calls).toHaveLength(0);
      expect(h.renderSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(h.storageRoot, ...missing.storageKey.split("/")))).toBe(false);
      const integrity = logs.map((line) => JSON.parse(line)).filter((line) => line.event === "document.integrity_failed");
      expect(integrity.map((line) => line.integrityStatus)).toContain("MISSING");
      expect(integrity.map((line) => line.integrityStatus)).toContain("HASH_MISMATCH");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AW: a delivery pinned to another hash is never served another manifest's bytes (even if those bytes exist)",
    async () => {
      const h = await start();
      const a = await h.issued();
      const b = await h.issued();
      const id = await h.requested(a.quoteId);
      // Pin A's delivery to B's (existing, valid) document: the manifest of A no longer matches.
      await h.sql(`update quote_service.quote_deliveries set document_sha256 = $2 where delivery_id = $1`, [id, b.pdfSha256]);

      await h.tick();
      expect(await h.row(id)).toMatchObject({ status: "pending", last_error_code: "document_storage_failed" });
      expect(h.sender.calls).toHaveLength(0);
      expect(h.readSpy).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "real issuance end to end: the attachment is byte-identical to GET /document; issuance itself created zero deliveries (BW)",
    async () => {
      const h = await start({ issuance: true });
      const created = await h.call("POST", "/v2/quotes", { key: `issue-${crypto.randomUUID()}`, body: example("create-and-issue.request.json") });
      expect([201, 202]).toContain(created.status);
      const quoteId = created.body.quote.quoteId as string;
      await waitFor(async () => (await h.quote(quoteId)).status === "issued", 30_000, 100);
      // BW: issuance created no delivery and called no sender.
      expect(await h.sql(`select count(*)::int as n from quote_service.quote_deliveries`)).toEqual([{ n: 0 }]);
      expect(h.sender.calls).toHaveLength(0);

      const document = await h.call("GET", `/v2/quotes/${quoteId}/document`);
      expect(document.status).toBe(200);
      const id = await h.requested(quoteId, { recipient: { email: "buyer@example.com" } });
      const renders = h.renderSpy.mock.calls.length;
      await h.tick();
      expect(await h.row(id)).toMatchObject({ status: "sent", document_sha256: sha256(document.bytes) });
      expect(h.sender.calls[0]!.attachments[0]!.content.equals(document.bytes)).toBe(true);
      expect(h.renderSpy.mock.calls.length).toBe(renders);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B durability across restart (BE/BF/BI)", () => {
  it(
    "next_attempt_at and attempt_count survive a new composition; the new process sends only when due; sent stays sent",
    async () => {
      const first = await start();
      const { quoteId } = await first.issued();
      const id = await first.requested(quoteId);
      first.sender.script.push(RETRYABLE());
      await first.tick();
      const before = await first.row(id);
      await first.context.shutdown("restart");

      const sender = new FakeSender();
      const second = await start({ databaseUrl: first.connectionString, storageRoot: first.storageRoot, sender });
      expect(await second.row(id)).toMatchObject({ status: "pending", attempt_count: 1, next_attempt_at: before.next_attempt_at, last_error_code: "email_rate_limited" });
      await second.tick();
      expect(sender.calls).toHaveLength(0);
      await second.makeDue(id);
      await second.tick();
      expect(await second.row(id)).toMatchObject({ status: "sent", attempt_count: 2, next_attempt_at: null });
      await second.tick();
      expect(sender.calls).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B cancellation races (BN/BO, quote → delivery lock order)", () => {
  it(
    "BO: claim first → cancel leaves `sending` untouched → the attempt completes; the quote stays cancelled",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const id = await h.requested(quoteId);
      const repository = h.repository();
      const claim = await repository.claimNext("owner:1:c");
      expect(claim.kind).toBe("CLAIMED");
      const version = (await h.quote(quoteId)).version as number;
      const cancel = await h.call("POST", `/v2/quotes/${quoteId}/cancel`, { key: `cancel-${crypto.randomUUID()}`, body: { expectedVersion: version, reasonCode: "customer_declined" } });
      expect(cancel.status).toBe(200);
      expect((await h.row(id)).status).toBe("sending");

      expect(await repository.complete(claim.kind === "CLAIMED" ? claim.delivery : (null as never), ACCEPTED())).toEqual({ kind: "SENT" });
      expect(await h.row(id)).toMatchObject({ status: "sent" });
      expect((await h.quote(quoteId)).status).toBe("cancelled");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BN/BO: claim vs cancel raced ×12: either cancel wins (failed quote_cancelled, never claimed) or the claim wins (sending kept); no deadlock",
    async () => {
      const h = await start();
      const repository = h.repository();
      const seen = new Set<string>();

      for (let round = 0; round < 12; round += 1) {
        const { quoteId } = await h.issued();
        const id = await h.requested(quoteId);
        const version = (await h.quote(quoteId)).version as number;
        const [claim, cancel] = await Promise.all([
          repository.claimNext(`racer:${round}`),
          h.call("POST", `/v2/quotes/${quoteId}/cancel`, { key: `cancel-${crypto.randomUUID()}`, body: { expectedVersion: version, reasonCode: "customer_declined" } })
        ]);
        expect(cancel.status).toBe(200);
        const row = await h.row(id);

        if (claim.kind === "CLAIMED") {
          seen.add("claim");
          expect(row.status).toBe("sending");
        } else {
          seen.add("cancel");
          expect(row).toMatchObject({ status: "failed", last_error_code: "quote_cancelled", attempt_count: 0 });
          // Never claimable afterwards.
          expect(await repository.claimNext(`late:${round}`)).toEqual({ kind: "NONE_AVAILABLE" });
        }

        expect((await h.quote(quoteId)).status).toBe("cancelled");
        await h.sql(`update quote_service.quote_deliveries set status = 'unknown', lease_owner = null, lease_expires_at = null, last_error_code = 'x_y' where status = 'sending'`);
      }

      expect(seen.size).toBeGreaterThanOrEqual(1);
      expect(h.sender.calls).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B sweep races (BP–BR)", () => {
  it(
    "BP: completion before sweep → sent (an expired-but-unswept lease is still the holder's); BQ: sweep first → unknown and the completion is fenced",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const repository = h.repository();

      const first = await h.requested(quoteId);
      const claimFirst = await repository.claimNext("bp:1");
      await h.expireLease(first);
      expect(await repository.complete(claimFirst.kind === "CLAIMED" ? claimFirst.delivery : (null as never), ACCEPTED())).toEqual({ kind: "SENT" });
      await h.sweep();
      expect(await h.row(first)).toMatchObject({ status: "sent" });

      const second = await h.requested(quoteId);
      const claimSecond = await repository.claimNext("bq:1");
      await h.expireLease(second);
      await h.sweep();
      expect(await repository.complete(claimSecond.kind === "CLAIMED" ? claimSecond.delivery : (null as never), ACCEPTED())).toEqual({ kind: "STALE", currentStatus: "unknown" });
      expect(await h.row(second)).toMatchObject({ status: "unknown", sent_at: null });

      const events = (await h.deliveryEvents(quoteId)).filter((event) => event.event_type !== "quote.delivery.requested");
      expect(events.map((event) => [event.event_type, event.data.deliveryId])).toEqual([
        ["quote.delivery.sent", first],
        ["quote.delivery.unknown", second]
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BP/BQ raced ×10 and BR two sweepers: exactly one terminal transition and one event per delivery",
    async () => {
      const h = await start();
      const { quoteId } = await h.issued();
      const repository = h.repository();
      const sweeper = h.repository();

      for (let round = 0; round < 10; round += 1) {
        const id = await h.requested(quoteId);
        const claim = await repository.claimNext(`race:${round}`);
        await h.expireLease(id);
        const [completion] = await Promise.all([
          repository.complete(claim.kind === "CLAIMED" ? claim.delivery : (null as never), ACCEPTED()),
          sweeper.sweepExpiredLeases(10),
          sweeper.sweepExpiredLeases(10)
        ]);
        const row = await h.row(id);
        expect(completion.kind === "SENT" ? "sent" : "unknown").toBe(row.status);
      }

      const events = (await h.deliveryEvents(quoteId)).filter((event) => event.event_type !== "quote.delivery.requested");
      const byDelivery = new Map<string, number>();

      for (const event of events) {
        byDelivery.set(event.data.deliveryId as string, (byDelivery.get(event.data.deliveryId as string) ?? 0) + 1);
      }

      expect(byDelivery.size).toBe(10);
      expect([...byDelivery.values()].every((count) => count === 1)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B request regression (BS–BV)", () => {
  it(
    "BS/BT/BU/BV: disabled → 503 and nothing queued; a bound key still replays after disable; an unhealthy provider still queues 202; a request never sends",
    async () => {
      const sender = new FakeSender();
      sender.fallback = RETRYABLE("email_provider_unavailable");
      const enabled = await start({ sender });
      const { quoteId } = await enabled.issued();
      const key = `bound-${crypto.randomUUID()}`;
      const accepted = await enabled.request(quoteId, {}, key);
      expect(accepted.status).toBe(202);
      expect(sender.calls).toHaveLength(0); // BV: queued, not sent synchronously

      await enabled.tick();
      expect(sender.calls).toHaveLength(1);
      const queued = await enabled.request(quoteId, {});
      expect(queued.status).toBe(202); // BU: provider failing, request still queues
      await enabled.context.shutdown("disable");

      const disabled = await start({ sender: null, databaseUrl: enabled.connectionString, storageRoot: enabled.storageRoot });
      const replay = await disabled.request(quoteId, {}, key);
      expect(replay.status).toBe(202);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      expect(replay.body.deliveryId).toBe(accepted.body.deliveryId);
      const count = (await disabled.sql(`select count(*)::int as n from quote_service.quote_deliveries`))[0]!.n;
      const rejected = await disabled.request(quoteId, {});
      expect(rejected.status).toBe(503);
      expect(rejected.body.error.details).toEqual({ dependency: "email_provider", retryable: false });
      expect((await disabled.sql(`select count(*)::int as n from quote_service.quote_deliveries`))[0]!.n).toBe(count);
      expect(disabled.context.delivery?.emailDelivery).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B email health and queue metrics (BX–CH)", () => {
  it(
    "BX: provider disabled → emailProvider disabled, emailDelivery worker disabled; the sweep still measures the queue",
    async () => {
      const h = await start({ sender: null });
      const health = await h.health();
      expect(health.dependencies.emailProvider).toEqual({ status: "disabled", failureCategory: null, lastSuccessAt: null });
      expect(health.workers.emailDelivery.enabled).toBe(false);
      await h.sweep();
      expect((await h.health()).workers.emailDelivery).toMatchObject({ queueDepth: 0, oldestPendingAgeSeconds: null });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BY/BZ/CA/CB/CC: success → up; credentials → down/authentication; rate limit or ambiguity → degraded; readiness, reads and document unaffected",
    async () => {
      const h = await start();
      const { quoteId, pdfSha256 } = await h.issued();
      expect((await h.health()).dependencies.emailProvider).toEqual({ status: "up", failureCategory: null, lastSuccessAt: null });

      await h.requested(quoteId);
      await h.tick();
      const up = (await h.health()).dependencies.emailProvider;
      expect(up).toMatchObject({ status: "up", failureCategory: null });
      expect(up.lastSuccessAt).not.toBeNull();

      await h.requested(quoteId);
      h.sender.script.push(RETRYABLE("email_authentication_failed"));
      await h.tick();
      expect((await h.health()).dependencies.emailProvider).toEqual({ status: "down", failureCategory: "authentication", lastSuccessAt: up.lastSuccessAt });

      await h.requested(quoteId);
      h.sender.script.push(AMBIGUOUS);
      await h.tick();
      expect((await h.health()).dependencies.emailProvider).toMatchObject({ status: "degraded", failureCategory: "provider_error" });

      // Email is never part of readiness, reads or the document.
      expect((await fetch(`${h.baseUrl}/health/ready`)).status).toBe(200);
      expect((await h.call("GET", `/v2/quotes/${quoteId}`)).status).toBe(200);
      const document = await h.call("GET", `/v2/quotes/${quoteId}/document`);
      expect(document.status).toBe(200);
      expect(sha256(document.bytes)).toBe(pdfSha256);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "CD/CE/CF/CG/CH: queueDepth counts due pending rows only; oldestPendingAgeSeconds from database time",
    async () => {
      const h = await start();
      await h.sweep();
      expect((await h.health()).workers.emailDelivery).toMatchObject({ enabled: true, queueDepth: 0, oldestPendingAgeSeconds: null });

      const { quoteId } = await h.issued();
      const ids = [await h.requested(quoteId), await h.requested(quoteId), await h.requested(quoteId), await h.requested(quoteId)];
      await h.sql(`update quote_service.quote_deliveries set next_attempt_at = clock_timestamp() - interval '90 seconds' where delivery_id = $1`, [ids[0]]);
      await h.sql(`update quote_service.quote_deliveries set next_attempt_at = clock_timestamp() + interval '1 hour' where delivery_id = $1`, [ids[1]]);
      await h.sweep();
      const metrics = (await h.health()).workers.emailDelivery;
      expect(metrics.queueDepth).toBe(3);
      expect(metrics.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(90);
      expect(metrics.oldestPendingAgeSeconds).toBeLessThan(120);

      // sent / failed / unknown / sending are not pending work.
      for (const [index, status] of [[0, "sent"], [2, "failed"], [3, "sending"]] as const) {
        await h.sql(
          `update quote_service.quote_deliveries
           set status = $2, last_error_code = case when $2 = 'failed' then 'x_y' end, sent_at = case when $2 = 'sent' then now() end,
               lease_owner = case when $2 = 'sending' then 'm' end, lease_expires_at = case when $2 = 'sending' then now() + interval '1 hour' end
           where delivery_id = $1`,
          [ids[index], status]
        );
      }

      await h.sweep();
      expect((await h.health()).workers.emailDelivery).toMatchObject({ queueDepth: 0, oldestPendingAgeSeconds: null });
    },
    TEST_TIMEOUT_MS
  );
});

describe("R1.6B privacy and redaction (§76)", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })
      )
    );
  });

  it(
    "hostile recipient, name, provider bodies, OAuth tokens and the Authorization header never reach logs or audit",
    async () => {
      const SECRET = {
        recipient: "pii.recipient.secret@example.com",
        name: "Nombre Secreto Ñandú",
        clientSecret: "gmail-client-secret-LEAK-CHECK-1",
        refreshToken: "gmail-refresh-token-LEAK-CHECK-2",
        accessToken: "gmail-access-token-LEAK-CHECK-3",
        providerBody: "PROVIDER-BODY-LEAK-CHECK-4"
      };
      const seen: string[] = [];
      let sends = 0;
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        request.on("end", () => {
          seen.push(`${request.url} ${request.headers.authorization ?? ""} ${body.length}`);

          if (request.url === "/token") {
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: SECRET.accessToken }));
            return;
          }

          sends += 1;
          const status = sends === 1 ? 400 : sends === 2 ? 503 : 200;
          response.writeHead(status, { "Content-Type": "application/json" }).end(
            JSON.stringify(status === 200 ? { id: "provider-id-ok" } : { error: { code: status, message: `${SECRET.providerBody} ${SECRET.recipient} ${SECRET.accessToken}` } })
          );
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const logs: string[] = [];
      const sender = new GmailMailSender({
        clientId: "client-id",
        clientSecret: SECRET.clientSecret,
        refreshToken: SECRET.refreshToken,
        from: { address: "cotizaciones@pesaschile.cl", name: "Pesas Chile" },
        replyTo: null,
        tokenTimeoutMs: 1_000,
        sendTimeoutMs: 2_000,
        endpoints: { token: `${base}/token`, send: `${base}/send` }
      });
      const h = await start({ sender, logs });
      const { quoteId } = await h.issued();
      const ids = [];

      for (let index = 0; index < 3; index += 1) {
        ids.push(await h.requested(quoteId, { recipient: { email: SECRET.recipient, name: SECRET.name } }));
        await h.tick();
      }

      expect((await h.row(ids[0]!)).status).toBe("failed");
      expect((await h.row(ids[1]!)).status).toBe("unknown");
      expect((await h.row(ids[2]!)).status).toBe("sent");
      // The real adapter really authenticated each send with the token (and the fake saw it), but nothing else did.
      expect(seen.filter((line) => line.startsWith("/send")).every((line) => line.includes(`Bearer ${SECRET.accessToken}`))).toBe(true);

      // The recipient snapshot is INTENTIONALLY persisted in the private columns (the worker needs it to send);
      // only the masked form is public.
      for (const id of ids) {
        expect(await h.row(id)).toMatchObject({ recipient_email: SECRET.recipient, recipient_name: SECRET.name, recipient_masked: "pi***@example.com" });
      }

      const audit = JSON.stringify(await h.sql(`select * from quote_service.quote_audit_events where quote_id = $1`, [quoteId]));
      // Every non-recipient column: error codes and provider ids only, never provider text or credentials.
      const operationalColumns = JSON.stringify(
        await h.sql(`select delivery_id, status, last_error_code, provider_message_id, lease_owner, recipient_masked from quote_service.quote_deliveries`)
      );
      const publicReads = JSON.stringify(await Promise.all(ids.map(async (id) => (await h.call("GET", `/v2/quotes/${quoteId}/deliveries/${id}`)).body)));
      expect(publicReads).toContain("pi***@example.com");
      const output = logs.join("\n");
      expect(output).toContain('"event":"delivery.sent"');
      expect(output).toContain('"event":"delivery.failed"');
      expect(output).toContain('"event":"delivery.outcome_unknown"');

      for (const value of [...Object.values(SECRET), "Bearer", "Cotización Pesas Chile"]) {
        expect(output, value).not.toContain(value);
        expect(audit, value).not.toContain(value);
        expect(operationalColumns, value).not.toContain(value);
        expect(publicReads, value).not.toContain(value);
      }
    },
    TEST_TIMEOUT_MS
  );
});
