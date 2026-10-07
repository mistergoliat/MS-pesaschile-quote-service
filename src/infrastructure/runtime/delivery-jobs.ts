import type { DeliveryQueueMetrics, DeliveryRepository } from "../../application/quote-v2/delivery/delivery-execution";
import { DeliveryLeaseSweeper, type DeliveryWorker } from "../../application/quote-v2/delivery/delivery-worker";
import type { LifecycleView, WorkerLogger } from "../../application/quote-v2/issuance-worker";
import type { CapabilityGate } from "./maintenance-jobs";
import { PeriodicJobRunner } from "./periodic-job-runner";

/*
 * Trigger wiring for V2 email delivery (R1.6B).
 *
 * - `emailDelivery` (send runner): composed only when a mail sender is
 *   configured. Gated on DELIVERY_SEND (persistence + artifact storage: it
 *   reads the committed PDF); a renderer outage does not pause email, and
 *   provider health is never a gate (the worker classifies each outcome).
 *   One attempt at a time per process.
 * - `deliveryOutcomeSweep`: ALWAYS composed, gated on PERSISTENCE only. It
 *   resolves expired `sending` leases to `unknown`, so it must keep running
 *   when the provider is disabled or broken, or storage is down. Each tick
 *   also refreshes the `emailDelivery` queue metrics from the database.
 *
 * The runners own no durable state: each tick asks PostgreSQL.
 */

export interface DeliveryJobs {
  readonly worker: DeliveryWorker | null;
  readonly emailDelivery: PeriodicJobRunner | null;
  readonly deliveryOutcomeSweep: PeriodicJobRunner;
  /** Last measured queue metrics (null until the first sweep tick). */
  queueMetrics(): DeliveryQueueMetrics | null;
}

export function createDeliveryJobs(input: {
  readonly repository: DeliveryRepository;
  /** Null when no mail sender is configured: no send runner. */
  readonly worker: DeliveryWorker | null;
  readonly pollIntervalMs: number;
  readonly readiness: CapabilityGate;
  readonly lifecycle: LifecycleView;
  readonly logger: WorkerLogger;
  readonly sweepBatchSize?: number;
}): DeliveryJobs {
  let metrics: DeliveryQueueMetrics | null = null;
  const sweeper = new DeliveryLeaseSweeper(input.repository, input.lifecycle, { batchSize: input.sweepBatchSize ?? 50, maxBatchesPerTick: 4 }, input.logger);
  const worker = input.worker;

  const emailDelivery = worker
    ? new PeriodicJobRunner({
        name: "emailDelivery",
        intervalMs: input.pollIntervalMs,
        logger: input.logger,
        canRun: () => input.readiness.canRun("DELIVERY_SEND"),
        execute: async () => {
          await worker.tick();
        }
      })
    : null;

  const deliveryOutcomeSweep = new PeriodicJobRunner({
    name: "deliveryOutcomeSweep",
    intervalMs: input.pollIntervalMs,
    logger: input.logger,
    canRun: () => input.readiness.canRun("PERSISTENCE"),
    execute: async () => {
      await sweeper.tick();
      metrics = await input.repository.queueMetrics();
    }
  });

  return {
    worker,
    emailDelivery,
    deliveryOutcomeSweep,
    queueMetrics: () => metrics
  };
}
