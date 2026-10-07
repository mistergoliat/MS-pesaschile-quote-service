/* eslint-disable @typescript-eslint/no-unsafe-member-access -- HTTP bodies and SQL rows are untyped by nature */
import crypto from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { MailSenderPort, MailSendOutcome } from "../../src/application/quote-v2/delivery/mail-sender-port";
import { issuanceQueueMetrics } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { responseErrors } from "../helpers/openapi-contract";
import { example, freshCleanups, startHarness, type Harness } from "../helpers/r16d-harness";

/*
 * R1.6D — real worker backlog metrics in `/health/dependencies`, measured in
 * PostgreSQL with the database clock. "Queue" means work due now for the
 * worker (the R1.6B `emailDelivery` definition): future backoff, live leases,
 * terminal rows and operations past their deadline are not queued.
 */

const TEST_TIMEOUT_MS = 120_000;
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  await run();
}, 60_000);

/** Accepts create-and-issue without executing it: one `pending` operation due now per call. */
async function pendingIssuance(harness: Harness): Promise<{ quoteId: string; operationId: string }> {
  const response = await harness.call("POST", "/v2/quotes", { key: `create-${crypto.randomUUID()}`, body: example("create-and-issue.request.json") });
  expect(response.status).toBe(202);
  return { quoteId: response.body.quote.quoteId as string, operationId: response.body.operation.operationId as string };
}

async function moveOperation(harness: Harness, operationId: string, assignments: string): Promise<void> {
  await harness.sql("begin");
  await harness.sql("set local session_replication_role = replica");
  await harness.sql(`update quote_service.issuance_operations set ${assignments} where operation_id = $1`, [operationId]);
  await harness.sql("commit");
}

const operationsSnapshot = (harness: Harness) =>
  harness.sql(`select operation_id, status, generation, attempt_count, next_attempt_at, lease_expires_at, updated_at from quote_service.issuance_operations order by operation_id`);

describe("issuance queue metrics (AF-AI, AN, AO)", () => {
  it("counts due work only, ages it from the database clock, and never writes", async () => {
    const harness = await startHarness({ cleanups, overrides: { disableIssuanceExecution: true } });
    const db = harness.context.database;

    // AF: empty.
    expect(await issuanceQueueMetrics(db)).toEqual({ queueDepth: 0, oldestPendingAgeSeconds: null });

    // AG: due pending work.
    const ops = [];
    for (let index = 0; index < 6; index += 1) {
      ops.push(await pendingIssuance(harness));
    }
    expect((await issuanceQueueMetrics(db)).queueDepth).toBe(6);

    // AH: future backoff is not due; AI: the oldest due item is aged from when it became due.
    await moveOperation(harness, ops[0]!.operationId, `next_attempt_at = clock_timestamp() + interval '10 minutes'`);
    await moveOperation(harness, ops[1]!.operationId, `next_attempt_at = clock_timestamp() - interval '120 seconds'`);
    // Reclaimable (running, lease expired) is due; a live lease is not.
    await moveOperation(harness, ops[2]!.operationId, `status = 'running', generation = 1, attempt_count = 1, lease_owner = 'w', lease_expires_at = clock_timestamp() - interval '1 second', next_attempt_at = null`);
    await moveOperation(harness, ops[3]!.operationId, `status = 'running', generation = 1, attempt_count = 1, lease_owner = 'w', lease_expires_at = clock_timestamp() + interval '1 minute', next_attempt_at = null`);
    // AN: terminal operations and operations past their deadline (the deadline sweep's work) are excluded.
    await moveOperation(harness, ops[4]!.operationId, `status = 'failed', last_error_code = 'document_generation_failed', completed_at = clock_timestamp(), next_attempt_at = null`);
    await moveOperation(harness, ops[5]!.operationId, `accepted_at = clock_timestamp() - interval '2 days', deadline_at = clock_timestamp() - interval '1 second'`);

    const before = await operationsSnapshot(harness);
    const metrics = await issuanceQueueMetrics(db);
    // ops[1] (due 120 s ago) and ops[2] (reclaimable).
    expect(metrics.queueDepth).toBe(2);
    expect(metrics.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(metrics.oldestPendingAgeSeconds).toBeLessThan(180);
    // AO: read only.
    expect(await operationsSnapshot(harness)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it("/health/dependencies reports the real issuance backlog during a renderer outage (worker paused, sweep measuring)", async () => {
    const acceptor = await startHarness({ cleanups, overrides: { disableIssuanceExecution: true } });
    await pendingIssuance(acceptor);
    await pendingIssuance(acceptor);
    await pendingIssuance(acceptor);

    const worker = await startHarness({ cleanups, databaseUrl: acceptor.databaseUrl, storageRoot: acceptor.storageRoot });
    await worker.rendererDown(true);
    expect(worker.monitor.canRun("ISSUANCE")).toBe(false);
    await worker.context.issuance!.issuance.runNow();
    await worker.context.issuance!.issuanceDeadlineSweep.runNow();

    const health = await worker.health();
    expect(responseErrors("/health/dependencies", "get", 200, health)).toEqual([]);
    expect(health.workers.issuance).toMatchObject({ enabled: true, queueDepth: 3 });
    expect(health.workers.issuance.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
    // Nothing was attempted: still pending.
    expect(await worker.sql(`select count(*)::int as n from quote_service.issuance_operations where status = 'pending' and attempt_count = 0`)).toEqual([{ n: 3 }]);

    // Renderer back: the worker drains the queue and the next measurement reports it.
    await worker.rendererDown(false);
    await worker.context.issuance!.issuance.runNow();
    await worker.context.issuance!.issuanceDeadlineSweep.runNow();
    expect((await worker.health()).workers.issuance).toMatchObject({ queueDepth: 0, oldestPendingAgeSeconds: null });
  }, TEST_TIMEOUT_MS);
});

describe("emailDelivery metrics regression (AM)", () => {
  it("R1.6B semantics are unchanged: due pending deliveries only; future retries excluded", async () => {
    const sender: MailSenderPort = { send: (): Promise<MailSendOutcome> => Promise.resolve({ kind: "accepted", providerMessageId: "id" }) };
    const harness = await startHarness({ cleanups, overrides: { testMailSender: sender } });
    const quote = await harness.issued();
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await harness.call("POST", `/v2/quotes/${quote.quoteId as string}/deliveries/email`, { key: `d-${crypto.randomUUID()}`, body: example("email-delivery.request.json") });
      ids.push(response.body.deliveryId as string);
    }

    await harness.context.delivery!.deliveryOutcomeSweep.runNow();
    expect((await harness.health()).workers.emailDelivery).toMatchObject({ enabled: true, queueDepth: 2 });

    await harness.sql(`update quote_service.quote_deliveries set next_attempt_at = clock_timestamp() + interval '1 hour' where delivery_id = $1`, [ids[0]]);
    await harness.context.delivery!.deliveryOutcomeSweep.runNow();
    expect((await harness.health()).workers.emailDelivery).toMatchObject({ queueDepth: 1 });

    await harness.context.delivery!.worker!.tick();
    await harness.context.delivery!.deliveryOutcomeSweep.runNow();
    expect((await harness.health()).workers.emailDelivery).toMatchObject({ queueDepth: 0, oldestPendingAgeSeconds: null });
  }, TEST_TIMEOUT_MS);
});
