/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- HTTP bodies and SQL rows are untyped by nature */
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { expiryQueueMetrics, materializeExpiredQuotes } from "../../src/infrastructure/persistence/postgres/quote-v2-expiry";
import { responseErrors } from "../helpers/openapi-contract";
import { freshCleanups, startHarness, type AnyRecord, type Harness } from "../helpers/r16d-harness";
import { waitFor } from "../helpers/runtime-test-env";

/*
 * R1.6D — expiry materialization (state machine T9, validity V-6) on real
 * PostgreSQL: the transition, its exact boundary, idempotency, concurrency
 * (8 workers), both cancel/expiry orders, outage and restart, and the
 * `workers.expiry` queue metrics. Validity is moved into the past with
 * `session_replication_role = replica` (harness.pastValidity); the periodic
 * runner is slowed to an hour and each test drives it explicitly.
 */

const TEST_TIMEOUT_MS = 120_000;
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  await run();
}, 60_000);

async function expiredQuote(harness: Harness, agoMs = 60_000): Promise<{ quoteId: string; boundary: Date; version: number }> {
  const quote = await harness.issued();
  const boundary = await harness.pastValidity(quote.quoteId as string, agoMs);
  return { quoteId: quote.quoteId as string, boundary, version: quote.version as number };
}

const expiryJob = (harness: Harness) => harness.context.expiry;

describe("expiry materialization: transition (G-N)", () => {
  it("G/H/I/J: an eligible issued quote becomes expired at exactly validUntilExclusive, version + 1, one quote.expired", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId, boundary, version } = await expiredQuote(harness, 3 * 3_600_000);
    const before = await harness.quoteRow(quoteId);

    await expiryJob(harness).runner.runNow();

    const after = await harness.quoteRow(quoteId);
    expect(after.status).toBe("expired");
    // H: the contractual boundary (three hours ago), never the run time.
    expect((after.expired_at as Date).toISOString()).toBe(boundary.toISOString());
    expect(after.version).toBe(version + 1);
    expect((after.updated_at as Date).getTime()).toBeGreaterThan((before.updated_at as Date).getTime());
    const events = await harness.sql(
      `select event_type, principal_id, from_status, to_status, operation_id, correlation_id, idempotency_key_hash, data
       from quote_service.quote_audit_events where quote_id = $1 and event_type = 'quote.expired'`,
      [quoteId]
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      principal_id: "system",
      from_status: "issued",
      to_status: "expired",
      correlation_id: null,
      idempotency_key_hash: null,
      data: { previousVersion: version, version: version + 1 }
    });
    expect(Object.keys(events[0]!.data as object).sort()).toEqual(["previousVersion", "quoteNumber", "version"]);
  }, TEST_TIMEOUT_MS);

  it("K/L: an already materialized quote and a quote still within validity are untouched (no version, timestamp or audit churn)", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId: expiredId } = await expiredQuote(harness);
    const future = await harness.issued();
    const draft = await harness.draft();

    await expiryJob(harness).runner.runNow();
    const firstPass = { expired: await harness.quoteRow(expiredId), future: await harness.quoteRow(future.quoteId), draft: await harness.quoteRow(draft.quoteId) };
    const auditCount = async () => (await harness.sql(`select count(*)::int as n from quote_service.quote_audit_events`))[0]!.n as number;
    const eventsAfterFirst = await auditCount();

    for (let index = 0; index < 3; index += 1) {
      await expiryJob(harness).runner.runNow();
    }

    expect(await harness.quoteRow(expiredId)).toEqual(firstPass.expired);
    expect(await harness.quoteRow(future.quoteId)).toEqual(firstPass.future);
    expect(firstPass.future.status).toBe("issued");
    expect(await harness.quoteRow(draft.quoteId)).toEqual(firstPass.draft);
    expect(await auditCount()).toBe(eventsAfterFirst);
    expect((await harness.auditTypes(expiredId)).filter((type) => type === "quote.expired")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("M/N: a projected-expired read before the job equals the materialized read except version and updatedAt", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId, boundary, version } = await expiredQuote(harness);

    const projected = await harness.call("GET", `/v2/quotes/${quoteId}`);
    expect(projected.status).toBe(200);
    expect(responseErrors("/v2/quotes/{quoteId}", "get", 200, projected.body)).toEqual([]);
    expect(projected.body).toMatchObject({ status: "expired", version, expiration: { expiredAt: boundary.toISOString() } });
    expect((await harness.quoteRow(quoteId)).status).toBe("issued");

    await expiryJob(harness).runner.runNow();

    const materialized = await harness.call("GET", `/v2/quotes/${quoteId}`);
    expect(materialized.status).toBe(200);
    expect(materialized.body.version).toBe(version + 1);
    const semantic = (body: AnyRecord) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== "version" && name !== "updatedAt"));
    expect(semantic(materialized.body)).toEqual(semantic(projected.body));

    // The document stays served after expiry (state machine §4).
    expect((await harness.call("GET", `/v2/quotes/${quoteId}/document`)).status).toBe(200);
  }, TEST_TIMEOUT_MS);
});

describe("expiry materialization: concurrency and races (O, P)", () => {
  it("O: 8 concurrent workers transition each quote exactly once (repeated)", async () => {
    const harness = await startHarness({ cleanups, env: { DB_POOL_MAX: "12" } });

    for (let round = 0; round < 3; round += 1) {
      const quotes = [];
      for (let index = 0; index < 4; index += 1) {
        quotes.push(await expiredQuote(harness));
      }
      const results = await Promise.all(Array.from({ length: 8 }, () => materializeExpiredQuotes(harness.context.database, 1)));

      // Batches of one, skip-locked: the 8 workers split the 4 quotes; the rest find nothing.
      expect(results.flat().map((entry) => entry.quoteId).sort()).toEqual(quotes.map((quote) => quote.quoteId).sort());
      await materializeExpiredQuotes(harness.context.database, 10);

      for (const quote of quotes) {
        expect(await harness.quoteRow(quote.quoteId)).toMatchObject({ status: "expired", version: quote.version + 1 });
        expect((await harness.auditTypes(quote.quoteId)).filter((type) => type === "quote.expired")).toHaveLength(1);
      }
    }
  }, TEST_TIMEOUT_MS);

  it("P1: expiry wins — a cancel waiting on the quote lock observes expired (409, details.status expired), no deadlock", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId, version } = await expiredQuote(harness);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The expiry transaction pauses after its writes, before COMMIT, still holding the quote row lock.
    const pausedDatabase = {
      query: harness.context.database.query.bind(harness.context.database),
      withTransaction: <T>(work: (client: pg.PoolClient) => Promise<T>) =>
        harness.context.database.withTransaction(async (client) => {
          const result = await work(client);
          locked();
          await gate;
          return result;
        })
    };

    const expiry = materializeExpiredQuotes(pausedDatabase, 10);
    await holding;
    const cancel = harness.call("POST", `/v2/quotes/${quoteId}/cancel`, { key: `cancel-${quoteId}`, body: { expectedVersion: version, reasonCode: "customer_declined" } });
    // Wait until the cancel is really blocked on the row lock, then let expiry commit.
    await waitFor(async () => (await harness.sql(`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%for update%'`))[0]!.n > 0, 10_000);
    release();

    expect((await expiry).map((entry) => entry.quoteId)).toEqual([quoteId]);
    const response = await cancel;
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "invalid_state_transition", details: { status: "expired" } });
    expect(await harness.quoteRow(quoteId)).toMatchObject({ status: "expired", version: version + 1 });
    expect(await harness.auditTypes(quoteId)).not.toContain("quote.cancelled");
  }, TEST_TIMEOUT_MS);

  it("P2: cancel wins while still cancellable — the expiry job never touches the cancelled quote", async () => {
    const harness = await startHarness({ cleanups });
    const quote = await harness.issued();
    const cancelled = await harness.call("POST", `/v2/quotes/${quote.quoteId}/cancel`, {
      key: `cancel-${quote.quoteId}`,
      body: { expectedVersion: quote.version, reasonCode: "customer_declined" }
    });
    expect(cancelled.status).toBe(200);
    // Later, its validity boundary passes.
    await harness.pastValidity(quote.quoteId as string);
    const before = await harness.quoteRow(quote.quoteId);

    await expiryJob(harness).runner.runNow();

    expect(await harness.quoteRow(quote.quoteId)).toEqual(before);
    expect(before.status).toBe("cancelled");
    expect(await harness.auditTypes(quote.quoteId)).not.toContain("quote.expired");
  }, TEST_TIMEOUT_MS);

  it("P3: a quote locked by another transaction is skipped, never waited on, and materialized on the next run", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId } = await expiredQuote(harness);
    const holder = new pg.Client({ connectionString: harness.databaseUrl });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("begin");
    await holder.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [quoteId]);

    expect(await materializeExpiredQuotes(harness.context.database, 10)).toEqual([]);
    await holder.query("rollback");
    expect((await materializeExpiredQuotes(harness.context.database, 10)).map((entry) => entry.quoteId)).toEqual([quoteId]);
  }, TEST_TIMEOUT_MS);
});

describe("expiry materialization: outage and restart (Q, R)", () => {
  it("Q: during a database outage the job pauses, nothing is mutated and the process stays live; it resumes after recovery", async () => {
    const harness = await startHarness({ cleanups });
    const { quoteId } = await expiredQuote(harness);

    await harness.databaseDown(true);
    expect(harness.monitor.canRun("PERSISTENCE")).toBe(false);
    await expiryJob(harness).runner.runNow();
    // A direct call against the dead pool fails cleanly (no partial write).
    await expect(materializeExpiredQuotes(harness.context.database, 10)).rejects.toThrow();
    expect((await harness.quoteRow(quoteId)).status).toBe("issued");
    expect((await harness.call("GET", "/health/live", { token: null })).status).toBe(200);

    await harness.databaseDown(false);
    await waitFor(() => harness.monitor.canRun("PERSISTENCE"), 15_000);
    await expiryJob(harness).runner.runNow();
    expect((await harness.quoteRow(quoteId)).status).toBe("expired");
  }, TEST_TIMEOUT_MS);

  it("Q2: renderer, storage and email outages do not stop the persistence-only expiry job", async () => {
    const harness = await startHarness({ cleanups });
    const first = await expiredQuote(harness);
    const second = await expiredQuote(harness);

    await harness.rendererDown(true);
    await expiryJob(harness).runner.runNow();
    expect((await harness.quoteRow(first.quoteId)).status).toBe("expired");

    await harness.rendererDown(false);
    await harness.storageDown(true);
    expect(harness.monitor.canRun("DOCUMENT_READ")).toBe(false);
    await expiryJob(harness).runner.runNow();
    expect((await harness.quoteRow(second.quoteId)).status).toBe("expired");
    expect(harness.context.backgroundJobs.status().expiry.enabled).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("R: after a restart (new process on the same database) the job resumes normally", async () => {
    const first = await startHarness({ cleanups });
    const { quoteId: earlier } = await expiredQuote(first);
    await first.context.shutdown("restart");

    const second = await startHarness({ cleanups, databaseUrl: first.databaseUrl, storageRoot: first.storageRoot });
    const { quoteId: later } = await expiredQuote(second);
    await second.context.expiry.runner.runNow();

    expect((await second.quoteRow(earlier)).status).toBe("expired");
    expect((await second.quoteRow(later)).status).toBe("expired");
  }, TEST_TIMEOUT_MS);
});

describe("expiry queue metrics (AJ, AK, AL)", () => {
  it("AJ/AK/AL: empty → 0/null; N unmaterialized → N with the oldest boundary age; read only", async () => {
    const harness = await startHarness({ cleanups });
    expect(await expiryQueueMetrics(harness.context.database)).toEqual({ queueDepth: 0, oldestPendingAgeSeconds: null });

    const oldest = await expiredQuote(harness, 600_000);
    await expiredQuote(harness, 120_000);
    await expiredQuote(harness, 30_000);
    await harness.issued(); // still valid: not counted

    const snapshot = async () => harness.sql(`select quote_id, status, version, updated_at from quote_service.quotes order by quote_id`);
    const before = await snapshot();
    const metrics = await expiryQueueMetrics(harness.context.database);
    expect(metrics.queueDepth).toBe(3);
    expect(metrics.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(metrics.oldestPendingAgeSeconds).toBeLessThan(660);
    expect(await snapshot()).toEqual(before);
    expect(oldest.boundary.getTime()).toBeLessThan(Date.now());

    // Through /health/dependencies: hold one quote so the tick cannot materialize it.
    const holder = new pg.Client({ connectionString: harness.databaseUrl });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("begin");
    await holder.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [oldest.quoteId]);
    await harness.context.expiry.runner.runNow();
    const held = (await harness.health()).workers.expiry;
    expect(responseErrors("/health/dependencies", "get", 200, await harness.health())).toEqual([]);
    expect(held).toMatchObject({ enabled: true, queueDepth: 1 });
    expect(held.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(held.lastPollAt).not.toBeNull();

    await holder.query("rollback");
    await harness.context.expiry.runner.runNow();
    expect((await harness.health()).workers.expiry).toMatchObject({ queueDepth: 0, oldestPendingAgeSeconds: null });
  }, TEST_TIMEOUT_MS);
});
