/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/app";
import { DependencyMonitor } from "../../src/application/health/dependency-monitor";
import { probeFailed } from "../../src/application/health/dependency-state";
import type { AttemptFailure, ClaimedAttempt, IssuanceAttemptErrorCode, OperationFence } from "../../src/application/quote-v2/issuance-operation";
import { IssuanceWorker, type AttemptBody } from "../../src/application/quote-v2/issuance-worker";
import { issuedSnapshotHash, SnapshotIntegrityError } from "../../src/application/quote-v2/issued-snapshot";
import { issuanceSettings } from "../../src/infrastructure/config/env";
import { PostgresIssuanceOperationRepository } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { buildConnectionConfig, CommitOutcomeUnknownError, PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { PostgresDependencyProbe } from "../../src/infrastructure/persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../../src/infrastructure/persistence/postgres/schema-head";
import { createIssuanceJobs } from "../../src/infrastructure/runtime/issuance-jobs";
import { r15aSemanticSnapshotHash } from "../helpers/r15a-snapshot-hash";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";

/*
 * R1.5B1 durable issuance operation core against real PostgreSQL.
 *
 * Time travel: the operation guard trigger keeps `accepted_at`/`deadline_at`
 * immutable, so tests move deadlines with `session_replication_role =
 * replica` on the superuser admin connection (triggers off for that one
 * statement, check constraints still on). Production code never does this.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 90_000;
const HOUR_MS = 3_600_000;
const LEASE_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function start(options: { pollIntervalMs?: number } = {}) {
  const testDatabase = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => testDatabase.dispose());
  await runMigrations({ databaseUrl: testDatabase.connectionString, direction: "up" });
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-issuance-ops-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const env = buildRuntimeTestEnv({
    databaseUrl: testDatabase.connectionString,
    storageRoot,
    overrides: {
      QUOTE_ISSUANCE_DEADLINE_MS: String(HOUR_MS),
      QUOTE_ISSUANCE_LEASE_MS: String(LEASE_MS),
      QUOTE_ISSUANCE_POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 500)
    }
  });
  // B1 drives the operation core directly; the application's own issuance execution stays off here.
  const context = buildApplication(env, { disableIssuanceExecution: true });
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  const database = new PostgresDatabase(env);
  cleanups.push(() => database.close());
  const repository = new PostgresIssuanceOperationRepository(database, { leaseMs: LEASE_MS, deadlineMs: HOUR_MS });
  const admin = new pg.Client({ connectionString: testDatabase.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());

  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;

  async function call(method: string, pathname: string, token: string, body?: unknown, key: string | null = crypto.randomUUID()) {
    const headers: Record<string, string> = { Authorization: bearer(token) };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (key !== null) {
      headers["Idempotency-Key"] = key;
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord };
  }

  const harness = {
    env,
    context,
    database,
    repository,
    sql,
    call,
    connectionString: testDatabase.connectionString,

    /** T4: `issuing`, version 1, pending operation (creator: sales-integration). */
    async createAndIssue(): Promise<{ quoteId: string; operationId: string; quote: AnyRecord }> {
      const response = await call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
      expect(response.status).toBe(202);
      return { quoteId: response.body.quote.quoteId, operationId: response.body.operation.operationId, quote: response.body.quote };
    },
    /** T1 + T3: `issuing`, version 2, pending operation (creator: backoffice, who may cancel). */
    async draftIssue(): Promise<{ quoteId: string; operationId: string; quote: AnyRecord }> {
      const draft = await call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, example("draft-create.request.json"));
      expect(draft.status).toBe(201);
      const issued = await call("POST", `/v2/quotes/${draft.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 });
      expect(issued.status).toBe(202);
      return { quoteId: draft.body.quoteId, operationId: issued.body.operation.operationId, quote: issued.body.quote };
    },
    cancel: (quoteId: string, expectedVersion: number) =>
      call("POST", `/v2/quotes/${quoteId}/cancel`, TEST_TOKENS.backoffice, { expectedVersion, reasonCode: "customer_declined" }),

    /** Writes with triggers disabled (time travel / impossible-state fixtures only). */
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
    /** Moves the operation's absolute deadline to now + offsetMs (accepted_at kept before it). */
    setDeadline: (operationId: string, offsetMs: number) =>
      harness.travel(
        `update quote_service.issuance_operations
         set deadline_at = date_trunc('milliseconds', clock_timestamp()) + $2 * interval '1 millisecond',
             accepted_at = least(accepted_at, date_trunc('milliseconds', clock_timestamp()) + $2 * interval '1 millisecond' - interval '1 hour')
         where operation_id = $1`,
        [operationId, offsetMs]
      ),
    expireLease: (operationId: string) =>
      sql(`update quote_service.issuance_operations set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = $1`, [operationId]),
    makeDue: (operationId: string) =>
      sql(`update quote_service.issuance_operations set next_attempt_at = clock_timestamp() - interval '1 millisecond' where operation_id = $1`, [operationId]),

    async op(operationId: string): Promise<AnyRecord> {
      return (
        await sql(
          `select *, generation::text as generation, (extract(epoch from (next_attempt_at - updated_at)) * 1000)::int as retry_in_ms,
                  (extract(epoch from (lease_expires_at - last_attempt_at)) * 1000)::int as lease_ms
           from quote_service.issuance_operations where operation_id = $1`,
          [operationId]
        )
      )[0]!;
    },
    async quote(quoteId: string): Promise<AnyRecord> {
      return (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },
    events: (quoteId: string, type?: string) =>
      sql(
        `select event_type, principal_id, operation_id, correlation_id, idempotency_key_hash, from_status, to_status, data
         from quote_service.quote_audit_events where quote_id = $1 ${type ? "and event_type = $2" : ""} order by sequence`,
        type ? [quoteId, type] : [quoteId]
      ),
    async counts(): Promise<AnyRecord> {
      return (
        await sql(
          `select (select count(*)::int from quote_service.quotes) as quotes,
                  (select count(*)::int from quote_service.issuance_operations) as operations,
                  (select count(*)::int from quote_service.issuance_operations where status in ('pending', 'running')) as active,
                  (select count(*)::int from quote_service.issuance_operations where status = 'succeeded') as succeeded,
                  (select count(*)::int from quote_service.quote_documents) as documents,
                  (select last_value::text from quote_service.quote_number_seq) as sequence`
        )
      )[0]!;
    },
    /** Claims expecting success. */
    async claim(owner: string): Promise<ClaimedAttempt> {
      const result = await repository.claimNext(owner);
      expect(result.kind).toBe("CLAIMED");
      return (result as { attempt: ClaimedAttempt }).attempt;
    },
    /** Holds the quote row lock, starts each request once the previous one is queued on a lock, then releases. */
    async raceOnQuoteLock<T>(quoteId: string, requests: Array<() => Promise<T>>): Promise<T[]> {
      const locker = new pg.Client({ connectionString: testDatabase.connectionString });
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

/** Fails a pending operation through the deadline sweep (T6). */
async function sweepToFailed(harness: Harness, operationId: string): Promise<void> {
  await harness.setDeadline(operationId, -1_000);
  const failed = await harness.repository.failDeadlineExceeded(10);
  expect(failed.map((failure) => failure.operationId)).toContain(operationId);
}

/** A retryable attempt failure (amendment A5); non-retryable failures are covered in issuance-commit tests. */
const retryable = (errorCode: IssuanceAttemptErrorCode): AttemptFailure => ({ errorCode, retryable: true, reason: errorCode });

const fenceOf = (attempt: ClaimedAttempt): OperationFence => ({
  operationId: attempt.operationId,
  generation: attempt.generation,
  leaseOwner: attempt.leaseOwner
});

describe("claim (Idempotency §4.3)", () => {
  it(
    "A/G/H/I: claims a due pending operation once: generation and attempts +1, lease = min(now + lease, deadline)",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", generation: "0", attempt_count: 0 });

      const attempt = await harness.claim("worker-a");
      expect(attempt).toMatchObject({ operationId, quoteId, generation: 1, attemptCount: 1, leaseOwner: "worker-a", reclaimed: false });
      expect(await harness.op(operationId)).toMatchObject({
        status: "running",
        generation: "1",
        attempt_count: 1,
        lease_owner: "worker-a",
        next_attempt_at: null,
        lease_ms: LEASE_MS
      });
      expect(attempt.leaseExpiresAt).toEqual((await harness.op(operationId)).lease_expires_at);

      // A live lease is not claimable.
      expect(await harness.repository.claimNext("worker-b")).toEqual({ kind: "NONE_AVAILABLE" });

      // I: a deadline closer than the lease caps the lease at the deadline.
      const second = await harness.createAndIssue();
      await harness.setDeadline(second.operationId, 5_000);
      const capped = await harness.claim("worker-b");
      const row = await harness.op(second.operationId);
      expect(capped.operationId).toBe(second.operationId);
      expect(row.lease_expires_at).toEqual(row.deadline_at);
      expect(capped.leaseExpiresAt).toEqual(row.deadline_at);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "B/C/D/E: never claims an operation not yet due, past its deadline, of a quote no longer issuing, or not current",
    async () => {
      const harness = await start();
      // E: a pending operation that is not the quote's current one.
      const stale = await harness.createAndIssue();
      await sweepToFailed(harness, stale.operationId);
      const retry = await harness.repository.createOperatorRetry({
        quoteId: stale.quoteId,
        failedOperationId: stale.operationId,
        actorPrincipalId: "backoffice"
      });
      expect(retry.kind).toBe("RETRY_CREATED");
      const current = (retry as { operationId: string }).operationId;
      await harness.travel(
        `update quote_service.issuance_operations
         set status = 'failed', completed_at = now(), last_error_code = 'issuance_deadline_exceeded', next_attempt_at = null
         where operation_id = $1`,
        [current]
      );
      await harness.travel(
        `update quote_service.issuance_operations
         set status = 'pending', completed_at = null, last_error_code = null, next_attempt_at = now() - interval '1 second',
             deadline_at = now() + interval '1 hour'
         where operation_id = $1`,
        [stale.operationId]
      );

      const notDue = await harness.createAndIssue();
      await harness.sql(`update quote_service.issuance_operations set next_attempt_at = clock_timestamp() + interval '1 hour' where operation_id = $1`, [
        notDue.operationId
      ]);
      const pastDeadline = await harness.createAndIssue();
      await harness.setDeadline(pastDeadline.operationId, -1);
      const cancelled = await harness.createAndIssue();
      await harness.travel(
        `update quote_service.quotes set status = 'cancelled', cancelled_at = now(), cancellation_reason_code = 'test_fixture',
                cancellation_initiated_by = 'sales-integration' where quote_id = $1`,
        [cancelled.quoteId]
      );
      expect(await harness.repository.claimNext("worker-a")).toEqual({ kind: "NONE_AVAILABLE" });

      for (const operationId of [notDue.operationId, pastDeadline.operationId, cancelled.operationId, stale.operationId]) {
        expect(await harness.op(operationId)).toMatchObject({ status: "pending", attempt_count: 0, lease_owner: null });
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "F: concurrent claimers converge on exactly one holder per operation",
    async () => {
      const harness = await start();
      const { operationId } = await harness.createAndIssue();
      const owners = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
      const results = await Promise.all(owners.map((owner) => harness.repository.claimNext(owner)));
      const winners = results.filter((result) => result.kind === "CLAIMED");

      expect(winners).toHaveLength(1);
      expect(await harness.op(operationId)).toMatchObject({
        status: "running",
        generation: "1",
        attempt_count: 1,
        lease_owner: (winners[0] as { attempt: ClaimedAttempt }).attempt.leaseOwner
      });

      // Several operations, more claimers than operations: each operation is held once.
      const others = [];

      for (let index = 0; index < 4; index += 1) {
        others.push((await harness.createAndIssue()).operationId);
      }

      const raced = await Promise.all(Array.from({ length: 12 }, (_, index) => harness.repository.claimNext(`racer-${index}`)));
      const claimed = raced.flatMap((result) => (result.kind === "CLAIMED" ? [result.attempt.operationId] : []));
      expect(new Set(claimed).size).toBe(claimed.length);

      for (let next = await harness.repository.claimNext("sweeper"); next.kind === "CLAIMED"; next = await harness.repository.claimNext("sweeper")) {
        claimed.push(next.attempt.operationId);
      }

      expect([...claimed].sort()).toEqual([...others].sort());

      for (const other of others) {
        expect(await harness.op(other)).toMatchObject({ status: "running", generation: "1", attempt_count: 1 });
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "J/K/L: an expired lease is reclaimed as the next generation of the same operation",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      const before = await harness.counts();
      const first = await harness.claim("worker-a");
      await harness.expireLease(operationId);
      const second = await harness.claim("worker-b");

      expect(second).toMatchObject({ operationId, quoteId, generation: 2, attemptCount: 2, leaseOwner: "worker-b", reclaimed: true });
      expect(first.generation).toBe(1);
      expect(await harness.op(operationId)).toMatchObject({ status: "running", generation: "2", attempt_count: 2, lease_owner: "worker-b" });
      expect(await harness.counts()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );
});

describe("fencing and lease renewal", () => {
  it(
    "M/N/O/P: stale generations and foreign holders have zero effect; the current holder renews, never past the deadline",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      const a = await harness.claim("worker-a");
      const claimedRow = await harness.op(operationId);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const renewed = await harness.repository.renewLease(fenceOf(a));
      expect(renewed.kind).toBe("RENEWED");
      expect((renewed as { leaseExpiresAt: Date }).leaseExpiresAt.getTime()).toBeGreaterThan(claimedRow.lease_expires_at.getTime());

      // P: right generation, wrong holder.
      const beforeIntruder = await harness.op(operationId);
      expect(await harness.repository.renewLease({ ...fenceOf(a), leaseOwner: "intruder" })).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.op(operationId)).toEqual(beforeIntruder);

      await harness.expireLease(operationId);
      const b = await harness.claim("worker-b");
      const reclaimedRow = await harness.op(operationId);
      const audit = await harness.events(quoteId);

      // M/N: the zombie generation can neither renew nor fail.
      expect(await harness.repository.renewLease(fenceOf(a))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.repository.failAttempt(fenceOf(a), retryable("document_storage_failed"))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.op(operationId)).toEqual(reclaimedRow);
      expect(await harness.events(quoteId)).toEqual(audit);

      // O: the current holder renews.
      expect((await harness.repository.renewLease(fenceOf(b))).kind).toBe("RENEWED");

      // Never past the absolute deadline; at/after it renewal fails and changes nothing.
      await harness.setDeadline(operationId, 3_000);
      await harness.repository.renewLease(fenceOf(b));
      const nearDeadline = await harness.op(operationId);
      expect(nearDeadline.lease_expires_at).toEqual(nearDeadline.deadline_at);

      await harness.setDeadline(operationId, -1);
      const atDeadline = await harness.op(operationId);
      expect(await harness.repository.renewLease(fenceOf(b))).toEqual({ kind: "DEADLINE_REACHED" });
      expect(await harness.op(operationId)).toEqual(atDeadline);
    },
    TEST_TIMEOUT_MS
  );
});

describe("attempt failure and backoff", () => {
  it(
    "Q–V/X/Y/Z: each failure reschedules with the exact schedule; the quote stays issuing with no new quote, number or operation",
    async () => {
      const harness = await start();
      const { quoteId, operationId, quote } = await harness.createAndIssue();
      // A far deadline so that no step of the schedule is capped by it (W covers the cap).
      await harness.setDeadline(operationId, 72 * HOUR_MS);
      const before = await harness.counts();
      const quoteBefore = await harness.quote(quoteId);
      const expected = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000];

      for (const [index, delay] of expected.entries()) {
        const attempt = await harness.claim("worker-a");
        expect(attempt.attemptCount).toBe(index + 1);
        const result = await harness.repository.failAttempt(fenceOf(attempt), retryable("document_storage_failed"));

        expect(result).toMatchObject({ kind: "RESCHEDULED", attemptCount: index + 1 });
        expect(await harness.op(operationId)).toMatchObject({
          status: "pending",
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: "document_storage_failed",
          retry_in_ms: delay,
          generation: String(index + 1)
        });
        // Not claimable before its retry time.
        expect(await harness.repository.claimNext("worker-a")).toEqual({ kind: "NONE_AVAILABLE" });
        await harness.makeDue(operationId);
      }

      const failures = await harness.events(quoteId, "quote.issue.attempt_failed");
      expect(failures.map((event) => [event.data.attempt, event.data.retryInMs, event.data.errorCode])).toEqual(
        expected.map((delay, index) => [index + 1, delay, "document_storage_failed"])
      );
      expect(failures.every((event) => event.principal_id === "system" && event.operation_id === operationId)).toBe(true);

      const quoteAfter = await harness.quote(quoteId);
      expect(quoteAfter).toEqual(quoteBefore);
      expect(quoteAfter).toMatchObject({ status: "issuing", quote_number: quote.quoteNumber, current_operation_id: operationId });
      expect(await harness.counts()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "W: the next attempt is never scheduled after the deadline",
    async () => {
      const harness = await start();
      const { operationId } = await harness.createAndIssue();
      const attempt = await harness.claim("worker-a");
      await harness.setDeadline(operationId, 2_000);
      const result = await harness.repository.failAttempt(fenceOf(attempt), retryable("dependency_unavailable"));
      const row = await harness.op(operationId);

      expect(result.kind).toBe("RESCHEDULED");
      expect(row.next_attempt_at).toEqual(row.deadline_at);
      expect((result as { nextAttemptAt: Date }).nextAttemptAt).toEqual(row.deadline_at);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AA/AB: a failure observed at the deadline terminally fails the operation once; the quote stays issuing",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      const attempt = await harness.claim("worker-a");
      await harness.setDeadline(operationId, -1);

      expect(await harness.repository.failAttempt(fenceOf(attempt), retryable("document_generation_failed"))).toEqual({ kind: "DEADLINE_REACHED" });
      const row = await harness.op(operationId);
      expect(row).toMatchObject({
        status: "failed",
        last_error_code: "issuance_deadline_exceeded",
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: null,
        generation: "1"
      });
      expect(row.completed_at).not.toBeNull();

      // Terminal and fenced: nothing repeats it.
      expect(await harness.repository.failAttempt(fenceOf(attempt), retryable("document_generation_failed"))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.repository.failDeadlineExceeded(10)).toEqual([]);
      expect(await harness.repository.claimNext("worker-b")).toEqual({ kind: "NONE_AVAILABLE" });

      const failed = await harness.events(quoteId, "quote.issue.failed");
      expect(failed).toEqual([
        {
          event_type: "quote.issue.failed",
          principal_id: "system",
          operation_id: operationId,
          correlation_id: null,
          idempotency_key_hash: null,
          from_status: "issuing",
          to_status: "issuing",
          data: { errorCode: "issuance_deadline_exceeded", lastAttemptErrorCode: "document_generation_failed", attempts: 1, generation: 1 }
        }
      ]);
      expect(await harness.quote(quoteId)).toMatchObject({ status: "issuing", current_operation_id: operationId });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AC: only sanitized codes are persisted, never messages, paths or customer data",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      const worker = new IssuanceWorker(
        harness.repository,
        () => Promise.reject(new Error("EACCES: open '/srv/quote/artifacts/tmp/x.tmp' for Camila Rojas camila.rojas@example.com")),
        { isShuttingDown: false },
        { leaseOwner: "worker-a", leaseMs: LEASE_MS, maxClaimsPerTick: 1 },
        silentLogger
      );

      expect(await worker.tick()).toBe(1);
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", last_error_code: "document_generation_failed" });
      const persisted = JSON.stringify([await harness.op(operationId), await harness.events(quoteId)]);
      expect(persisted).not.toMatch(/EACCES|\/srv|tmp|Camila|example\.com/);
    },
    TEST_TIMEOUT_MS
  );
});

describe("deadline sweep (T6)", () => {
  it(
    "AD–AJ: fails pending and expired-lease operations past the deadline, never a live lease; idempotent; quotes stay issuing",
    async () => {
      const harness = await start();
      // Running operations first (the claim takes the oldest due).
      const expiredRunning = await harness.createAndIssue();
      const zombie = await harness.claim("zombie");
      const liveRunning = await harness.createAndIssue();
      const live = await harness.claim("live-holder");
      const duePending = await harness.createAndIssue();
      const futurePending = await harness.createAndIssue();
      await harness.sql(`update quote_service.issuance_operations set next_attempt_at = clock_timestamp() + interval '1 hour' where operation_id = $1`, [
        futurePending.operationId
      ]);

      await harness.setDeadline(expiredRunning.operationId, -1_000);
      await harness.expireLease(expiredRunning.operationId);
      await harness.setDeadline(liveRunning.operationId, -1_000);
      await harness.sql(`update quote_service.issuance_operations set lease_expires_at = clock_timestamp() + interval '1 minute' where operation_id = $1`, [
        liveRunning.operationId
      ]);
      await harness.setDeadline(duePending.operationId, -1_000);
      const quoteVersions = await harness.sql(`select quote_id, version, status, quote_number from quote_service.quotes order by quote_id`);

      const failed = await harness.repository.failDeadlineExceeded(50);
      expect(failed.map((failure) => [failure.operationId, failure.previousStatus]).sort()).toEqual(
        [
          [expiredRunning.operationId, "running"],
          [duePending.operationId, "pending"]
        ].sort()
      );

      // AD/AF: failed with the deadline code; AH: the zombie's generation is fenced out.
      for (const { operationId } of [expiredRunning, duePending]) {
        const row = await harness.op(operationId);
        expect(row).toMatchObject({ status: "failed", last_error_code: "issuance_deadline_exceeded", lease_owner: null, next_attempt_at: null });
        expect(row.completed_at).not.toBeNull();
      }

      expect((await harness.op(expiredRunning.operationId)).generation).toBe("2");
      expect((await harness.op(duePending.operationId)).generation).toBe("1");
      expect(await harness.repository.renewLease(fenceOf(zombie))).toEqual({ kind: "STALE_FENCE" });
      expect(await harness.repository.failAttempt(fenceOf(zombie), retryable("document_storage_failed"))).toEqual({ kind: "STALE_FENCE" });

      // AE/AG: untouched.
      expect(await harness.op(futurePending.operationId)).toMatchObject({ status: "pending", generation: "0" });
      expect(await harness.op(liveRunning.operationId)).toMatchObject({ status: "running", generation: "1", lease_owner: "live-holder" });
      expect((await harness.repository.renewLease(fenceOf(live))).kind).toBe("DEADLINE_REACHED");

      // AI: idempotent: no second event, no version churn. AJ: quotes unchanged (still issuing).
      const audit = await harness.sql(`select count(*)::int as n from quote_service.quote_audit_events where event_type = 'quote.issue.failed'`);
      expect(audit[0]!.n).toBe(2);
      expect(await harness.repository.failDeadlineExceeded(50)).toEqual([]);
      expect(await harness.sql(`select count(*)::int as n from quote_service.quote_audit_events where event_type = 'quote.issue.failed'`)).toEqual(audit);
      expect(await harness.sql(`select quote_id, version, status, quote_number from quote_service.quotes order by quote_id`)).toEqual(quoteVersions);
      expect(quoteVersions.every((quote) => quote.status === "issuing")).toBe(true);

      for (const { quoteId, operationId } of [expiredRunning, duePending]) {
        expect(await harness.events(quoteId, "quote.issue.failed")).toEqual([
          expect.objectContaining({ principal_id: "system", operation_id: operationId, from_status: "issuing", to_status: "issuing" })
        ]);
      }

      // Once the live lease expires the sweep takes it too.
      await harness.expireLease(liveRunning.operationId);
      expect((await harness.repository.failDeadlineExceeded(50)).map((failure) => failure.operationId)).toEqual([liveRunning.operationId]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AK/AL/AM: the sweep is gated on persistence readiness only; attempts need full readiness",
    async () => {
      const harness = await start();
      const expired = await harness.createAndIssue();
      await harness.setDeadline(expired.operationId, -1_000);
      const due = await harness.createAndIssue();
      const lifecycle = { isShuttingDown: false };
      const manifest = loadMigrationManifest();
      const realDatabase = new PostgresDependencyProbe(buildConnectionConfig(harness.env), manifest);
      const monitorWith = (database: ConstructorParameters<typeof DependencyMonitor>[0]["database"]) =>
        new DependencyMonitor(
          {
            database,
            artifactStorage: { probe: () => Promise.resolve(probeFailed("storage_read_only")) },
            renderer: { probe: () => Promise.resolve(probeFailed("renderer_unavailable")) }
          },
          lifecycle,
          { intervalMs: 60_000, retryMinMs: 100, retryMaxMs: 400, probeTimeoutMs: 2_000, expectedSchemaHead: manifest.expectedHead },
          silentLogger
        );
      const body = vi.fn<AttemptBody>(() => Promise.resolve({ kind: "abandoned" }));
      const jobsWith = (monitor: DependencyMonitor) =>
        createIssuanceJobs({
          repository: harness.repository,
          attemptBody: body,
          leaseOwner: "worker-a",
          settings: issuanceSettings(harness.env),
          readiness: monitor,
          lifecycle,
          logger: silentLogger
        });

      // AM: database (as seen by the monitor) down → the sweep does not run.
      const dbDown = monitorWith({ probe: () => Promise.resolve({ connection: probeFailed("unreachable"), schema: { state: "DB_UNAVAILABLE", actualHead: null } }) });
      await dbDown.probeNow();
      await jobsWith(dbDown).issuanceDeadlineSweep.runNow();
      expect(await harness.op(expired.operationId)).toMatchObject({ status: "pending" });

      // AK/AL: storage and renderer down, database up → the sweep runs, attempts do not.
      const degraded = monitorWith(realDatabase);
      await degraded.probeNow();
      expect(degraded.isReady()).toBe(false);
      const jobs = jobsWith(degraded);
      await jobs.issuance.runNow();
      await jobs.issuanceDeadlineSweep.runNow();

      expect(await harness.op(expired.operationId)).toMatchObject({ status: "failed", last_error_code: "issuance_deadline_exceeded" });
      expect(await harness.op(due.operationId)).toMatchObject({ status: "pending", attempt_count: 0 });
      expect(body).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS
  );
});

describe("issued snapshot loading and integrity", () => {
  it(
    "AP: the worker loader reproduces the hash frozen at acceptance (direct create and issued draft)",
    async () => {
      const harness = await start();

      for (const accepted of [await harness.createAndIssue(), await harness.draftIssue()]) {
        const row = await harness.op(accepted.operationId);
        const snapshot = await harness.repository.loadVerifiedSnapshot(accepted.operationId);

        expect(row.snapshot_hash_algorithm).toBe("jcs-sha256-v2");
        expect(issuedSnapshotHash(snapshot)).toBe(row.snapshot_hash);
        // Same hash as the R1.5A derivation over the public representation returned at acceptance.
        expect(row.snapshot_hash).toBe(r15aSemanticSnapshotHash(accepted.quote));
        expect(snapshot.quoteNumber).toBe(accepted.quote.quoteNumber);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "AR/AS: a tampered snapshot is detected before the attempt body; nothing is repaired and no external call is made",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.createAndIssue();
      await harness.travel(`update quote_service.quote_lines set item_description = 'Tampered description' where quote_id = $1 and position = 1`, [
        quoteId
      ]);

      await expect(harness.repository.loadVerifiedSnapshot(operationId)).rejects.toBeInstanceOf(SnapshotIntegrityError);

      const body = vi.fn<AttemptBody>();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const worker = new IssuanceWorker(
        harness.repository,
        body,
        { isShuttingDown: false },
        { leaseOwner: "worker-a", leaseMs: LEASE_MS, maxClaimsPerTick: 1 },
        silentLogger
      );

      try {
        expect(await worker.tick()).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }

      expect(body).not.toHaveBeenCalled();
      // Amendment A5 (R1.5B3): a snapshot integrity mismatch is non-retryable: the operation fails at once (T12).
      expect(await harness.op(operationId)).toMatchObject({ status: "failed", last_error_code: "document_generation_failed", next_attempt_at: null });
      expect(await harness.sql(`select item_description from quote_service.quote_lines where quote_id = $1 and position = 1`, [quoteId])).toEqual([
        { item_description: "Tampered description" }
      ]);
    },
    TEST_TIMEOUT_MS
  );
});

describe("operator retry (T10)", () => {
  it(
    "AT–AY: creates one new pending operation for the same quote, number and snapshot, with a new deadline",
    async () => {
      const harness = await start();
      const { quoteId, operationId: failedId, quote } = await harness.draftIssue();
      await sweepToFailed(harness, failedId);
      const failedRow = await harness.op(failedId);
      const quoteBefore = await harness.quote(quoteId);
      const before = await harness.counts();

      const result = await harness.repository.createOperatorRetry({
        quoteId,
        failedOperationId: failedId,
        actorPrincipalId: "backoffice",
        correlationId: "ops-ticket-17"
      });
      expect(result.kind).toBe("RETRY_CREATED");
      const retryId = (result as { operationId: string }).operationId;
      const retry = await harness.op(retryId);

      expect(retry).toMatchObject({
        quote_id: quoteId,
        origin: "operator_retry",
        retry_of_operation_id: failedId,
        status: "pending",
        generation: "0",
        attempt_count: 0,
        lease_owner: null,
        last_error_code: null,
        completed_at: null,
        snapshot_hash: failedRow.snapshot_hash,
        snapshot_hash_algorithm: "jcs-sha256-v2"
      });
      expect(retry.next_attempt_at).toEqual(retry.accepted_at);
      expect(retry.deadline_at.getTime() - retry.accepted_at.getTime()).toBe(HOUR_MS);
      expect(retry.accepted_at.getTime()).toBeGreaterThan(failedRow.accepted_at.getTime());
      expect((result as { deadlineAt: Date }).deadlineAt).toEqual(retry.deadline_at);

      expect(await harness.quote(quoteId)).toEqual({
        ...quoteBefore,
        current_operation_id: retryId,
        version: quoteBefore.version + 1,
        updated_at: retry.accepted_at
      });
      expect(await harness.counts()).toEqual({ ...before, operations: before.operations + 1, active: before.active + 1 });
      expect(await harness.op(failedId)).toEqual(failedRow);
      expect((await harness.events(quoteId)).at(-1)).toEqual({
        event_type: "quote.issue.accepted",
        principal_id: "backoffice",
        operation_id: retryId,
        correlation_id: "ops-ticket-17",
        idempotency_key_hash: null,
        from_status: "issuing",
        to_status: "issuing",
        data: {
          retryOf: failedId,
          quoteNumber: quote.quoteNumber,
          previousVersion: quoteBefore.version,
          version: quoteBefore.version + 1,
          deadlineAt: retry.deadline_at.toISOString()
        }
      });

      // The public read shows the new current operation; the new operation is claimable.
      const read = await harness.call("GET", `/v2/quotes/${quoteId}`, TEST_TOKENS.backoffice, undefined, null);
      expect(read.body).toMatchObject({ status: "issuing", quoteNumber: quote.quoteNumber, issuance: { operationId: retryId } });
      expect((await harness.claim("worker-a")).operationId).toBe(retryId);

      // AZ: no retry while the current operation is active.
      expect(await harness.repository.createOperatorRetry({ quoteId, failedOperationId: failedId, actorPrincipalId: "backoffice" })).toEqual({
        kind: "INVALID_STATE",
        quoteStatus: "issuing",
        currentOperationId: retryId,
        currentOperationStatus: "running"
      });
      expect(await harness.repository.createOperatorRetry({ quoteId, failedOperationId: retryId, actorPrincipalId: "backoffice" })).toMatchObject({
        kind: "INVALID_STATE",
        currentOperationStatus: "running"
      });
      expect(await harness.repository.createOperatorRetry({ quoteId: crypto.randomUUID(), failedOperationId: failedId, actorPrincipalId: "backoffice" })).toEqual({
        kind: "QUOTE_NOT_FOUND"
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BA: no retry for a cancelled, issued or expired quote; a cancelled quote's operation is never claimed",
    async () => {
      const harness = await start();
      const cancelled = await harness.draftIssue();
      await sweepToFailed(harness, cancelled.operationId);
      expect((await harness.cancel(cancelled.quoteId, 2)).status).toBe(200);
      expect(await harness.repository.createOperatorRetry({ quoteId: cancelled.quoteId, failedOperationId: cancelled.operationId, actorPrincipalId: "backoffice" })).toEqual({
        kind: "INVALID_STATE",
        quoteStatus: "cancelled",
        currentOperationId: cancelled.operationId,
        currentOperationStatus: "failed"
      });
      expect(await harness.repository.claimNext("worker-a")).toEqual({ kind: "NONE_AVAILABLE" });

      for (const terminal of ["issued", "expired"] as const) {
        const accepted = await harness.createAndIssue();
        await harness.travel(
          `update quote_service.issuance_operations set status = 'failed', completed_at = now(), last_error_code = 'issuance_deadline_exceeded',
                  next_attempt_at = null where operation_id = $1`,
          [accepted.operationId]
        );
        await harness.travel(
          `update quote_service.quotes set status = $2, expired_at = case when $2 = 'expired' then valid_until_exclusive end where quote_id = $1`,
          [accepted.quoteId, terminal]
        );
        expect(
          await harness.repository.createOperatorRetry({ quoteId: accepted.quoteId, failedOperationId: accepted.operationId, actorPrincipalId: "backoffice" })
        ).toMatchObject({ kind: "INVALID_STATE", quoteStatus: terminal });
      }

      expect((await harness.counts()).active).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BB: six concurrent retries of one failed operation create exactly one new operation",
    async () => {
      const harness = await start();
      const { quoteId, operationId } = await harness.draftIssue();
      await sweepToFailed(harness, operationId);
      const before = await harness.counts();

      const results = await Promise.all(
        Array.from({ length: 6 }, () => harness.repository.createOperatorRetry({ quoteId, failedOperationId: operationId, actorPrincipalId: "backoffice" }))
      );

      expect(results.filter((result) => result.kind === "RETRY_CREATED")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "INVALID_STATE")).toHaveLength(5);
      expect(await harness.counts()).toEqual({ ...before, operations: before.operations + 1, active: 1 });
      expect(await harness.events(quoteId, "quote.issue.accepted")).toHaveLength(2);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BC: retry and creator cancel serialize on the quote row: whichever runs first wins",
    async () => {
      const harness = await start();

      // Retry first: the cancel then sees an active operation.
      const first = await harness.draftIssue();
      await sweepToFailed(harness, first.operationId);
      const [retryWins, cancelLoses] = (await harness.raceOnQuoteLock<AnyRecord>(first.quoteId, [
        () => harness.repository.createOperatorRetry({ quoteId: first.quoteId, failedOperationId: first.operationId, actorPrincipalId: "backoffice" }),
        () => harness.cancel(first.quoteId, 2)
      ])) as [AnyRecord, AnyRecord];
      expect(retryWins.kind).toBe("RETRY_CREATED");
      expect(cancelLoses).toMatchObject({ status: 409, body: { error: { code: "operation_in_progress" } } });
      expect(await harness.quote(first.quoteId)).toMatchObject({ status: "issuing", current_operation_id: retryWins.operationId, version: 3 });

      // Cancel first: the retry then sees a cancelled quote and creates nothing.
      const second = await harness.draftIssue();
      await sweepToFailed(harness, second.operationId);
      const before = await harness.counts();
      const [cancelWins, retryLoses] = (await harness.raceOnQuoteLock<AnyRecord>(second.quoteId, [
        () => harness.cancel(second.quoteId, 2),
        () => harness.repository.createOperatorRetry({ quoteId: second.quoteId, failedOperationId: second.operationId, actorPrincipalId: "backoffice" })
      ])) as [AnyRecord, AnyRecord];
      expect(cancelWins.status).toBe(200);
      expect(retryLoses).toMatchObject({ kind: "INVALID_STATE", quoteStatus: "cancelled" });
      expect((await harness.counts()).operations).toBe(before.operations);
      expect(await harness.quote(second.quoteId)).toMatchObject({ status: "cancelled", current_operation_id: second.operationId });
    },
    TEST_TIMEOUT_MS
  );
});

describe("shutdown and activation safety", () => {
  it(
    "BD/BE/BF/BG: shutdown stops claiming, abandons the in-flight attempt without any write, and the lease stays reclaimable",
    async () => {
      const harness = await start({ pollIntervalMs: 500 });
      const { operationId } = await harness.createAndIssue();
      const lifecycle = { isShuttingDown: true };
      let attemptSignal: AbortSignal | null = null;
      const body: AttemptBody = ({ signal }) =>
        new Promise((resolve) => {
          attemptSignal = signal;
          signal.addEventListener("abort", () => resolve({ kind: "abandoned" }));
        });
      const jobs = createIssuanceJobs({
        repository: harness.repository,
        attemptBody: body,
        leaseOwner: "worker-a",
        settings: issuanceSettings(harness.env),
        readiness: { isReady: () => true, isPersistenceReady: () => true },
        lifecycle,
        logger: silentLogger
      });

      // BD: shutting down → no claim.
      await jobs.issuance.runNow();
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", attempt_count: 0 });

      // BG: an attempt in flight when shutdown starts is abandoned: no success, no failure write.
      lifecycle.isShuttingDown = false;
      const tick = jobs.issuance.runNow();
      await waitFor(() => attemptSignal !== null);
      const running = await harness.op(operationId);
      expect(running).toMatchObject({ status: "running", lease_owner: "worker-a" });
      lifecycle.isShuttingDown = true;
      await jobs.stop();
      await tick;
      expect(attemptSignal!.aborted).toBe(true);
      expect(await harness.op(operationId)).toEqual(running);
      expect((await harness.counts()).succeeded).toBe(0);

      // BE: stopped runners never claim again, even when work is due.
      lifecycle.isShuttingDown = false;
      await harness.expireLease(operationId);
      jobs.issuance.start();
      await jobs.stop();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await harness.op(operationId)).toMatchObject({ status: "running", generation: "1", lease_owner: "worker-a" });

      // BF: the abandoned lease expired; another process reclaims the same operation.
      const reclaimed = await harness.claim("worker-b");
      expect(reclaimed).toMatchObject({ operationId, generation: 2, reclaimed: true });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "with issuance execution disabled (test seam) the service never claims or fails accepted operations",
    async () => {
      const harness = await start({ pollIntervalMs: 500 });
      const { operationId } = await harness.createAndIssue();
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      expect(await harness.op(operationId)).toMatchObject({ status: "pending", generation: "0", attempt_count: 0, last_error_code: null });
      expect(harness.context.backgroundJobs.status()).toMatchObject({
        issuance: { enabled: false },
        issuanceDeadlineSweep: { enabled: false }
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe("commit outcome unknown (§19)", () => {
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

  it(
    "re-reads durable state instead of guessing: committed effects are reported, rolled-back ones are not",
    async () => {
      const harness = await start();
      const config = { leaseMs: LEASE_MS, deadlineMs: HOUR_MS };
      const committed = new PostgresIssuanceOperationRepository(ambiguous(harness.database, "committed"), config);
      const rolledBack = new PostgresIssuanceOperationRepository(ambiguous(harness.database, "rolled_back"), config);
      const { quoteId, operationId } = await harness.createAndIssue();

      // Claim.
      expect(await rolledBack.claimNext("worker-a")).toEqual({ kind: "NONE_AVAILABLE" });
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", generation: "0" });
      const claimed = await committed.claimNext("worker-a");
      expect(claimed).toMatchObject({ kind: "CLAIMED", attempt: { operationId, generation: 1, leaseOwner: "worker-a" } });
      const attempt = (claimed as { attempt: ClaimedAttempt }).attempt;

      // Renew.
      expect((await committed.renewLease(fenceOf(attempt))).kind).toBe("RENEWED");

      // Fail attempt.
      expect(await rolledBack.failAttempt(fenceOf(attempt), retryable("document_storage_failed"))).toEqual({ kind: "NOT_APPLIED" });
      expect(await harness.op(operationId)).toMatchObject({ status: "running", generation: "1" });
      expect(await committed.failAttempt(fenceOf(attempt), retryable("document_storage_failed"))).toMatchObject({ kind: "RESCHEDULED", attemptCount: 1 });
      expect(await harness.op(operationId)).toMatchObject({ status: "pending", last_error_code: "document_storage_failed" });
      expect(await harness.events(quoteId, "quote.issue.attempt_failed")).toHaveLength(1);

      // Operator retry.
      await sweepToFailed(harness, operationId);
      const before = await harness.counts();
      expect(await rolledBack.createOperatorRetry({ quoteId, failedOperationId: operationId, actorPrincipalId: "backoffice" })).toEqual({
        kind: "NOT_APPLIED"
      });
      expect(await harness.counts()).toEqual(before);
      const created = await committed.createOperatorRetry({ quoteId, failedOperationId: operationId, actorPrincipalId: "backoffice" });
      expect(created.kind).toBe("RETRY_CREATED");
      expect((await harness.quote(quoteId)).current_operation_id).toBe((created as { operationId: string }).operationId);
    },
    TEST_TIMEOUT_MS
  );
});
