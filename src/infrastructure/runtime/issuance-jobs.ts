import type { DeliveryQueueMetrics } from "../../application/quote-v2/delivery/delivery-execution";
import type { IssuanceFailpoints } from "../../application/quote-v2/issuance-failpoints";
import type { IssuanceOperationRepository } from "../../application/quote-v2/issuance-operation";
import {
  IssuanceDeadlineSweeper,
  IssuanceWorker,
  type AttemptBody,
  type LifecycleView,
  type WorkerLogger
} from "../../application/quote-v2/issuance-worker";
import type { IssuanceSettings } from "../config/env";
import type { CapabilityGate } from "./maintenance-jobs";
import { PeriodicJobRunner } from "./periodic-job-runner";

/*
 * Trigger wiring for the issuance worker and the deadline sweep.
 *
 * ACTIVATION (R1.5B3): composed by buildApplication with the real attempt
 * body (issuance-attempt.ts). One attempt at a time per process: the worker's
 * single slot is shared with the inline path.
 *
 * The runners own no durability: each tick asks PostgreSQL for due work and
 * the claim decides. Fixed delay (no overlap, no drift), no retry/backoff in
 * the timer. Attempts are gated on ISSUANCE (database, schema, storage,
 * renderer, lifecycle); the sweep on DEADLINE_SWEEP (persistence only), so an
 * operation still reaches its terminal state during a storage or renderer
 * outage (§4.3 deadline sweep, I15). The sweep tick also measures the
 * `workers.issuance` backlog (R1.6D), so the metric stays truthful while the
 * worker itself is paused by a renderer or storage outage.
 */

export interface IssuanceJobs {
  readonly worker: IssuanceWorker;
  readonly issuance: PeriodicJobRunner;
  readonly issuanceDeadlineSweep: PeriodicJobRunner;
  /** Last measured queue metrics (null until the first sweep tick). */
  queueMetrics(): DeliveryQueueMetrics | null;
  /** Stop order for shutdown: no new claims, abort the in-flight attempt, then stop both timers. */
  stop(): Promise<void>;
}

export function createIssuanceJobs(input: {
  readonly repository: IssuanceOperationRepository;
  readonly attemptBody: AttemptBody;
  readonly leaseOwner: string;
  readonly settings: IssuanceSettings;
  readonly readiness: CapabilityGate;
  /** Backlog measurement run after each sweep tick (read only). */
  readonly measureQueue?: () => Promise<DeliveryQueueMetrics>;
  readonly lifecycle: LifecycleView;
  readonly logger: WorkerLogger;
  readonly maxClaimsPerTick?: number;
  readonly sweepBatchSize?: number;
  /** Test compositions only (issuance-failpoints.ts). */
  readonly failpoints?: IssuanceFailpoints | undefined;
}): IssuanceJobs {
  const worker = new IssuanceWorker(
    input.repository,
    input.attemptBody,
    input.lifecycle,
    { leaseOwner: input.leaseOwner, leaseMs: input.settings.leaseMs, maxClaimsPerTick: input.maxClaimsPerTick ?? 5 },
    input.logger,
    input.failpoints
  );
  const sweeper = new IssuanceDeadlineSweeper(
    input.repository,
    input.lifecycle,
    { batchSize: input.sweepBatchSize ?? 50, maxBatchesPerTick: 4 },
    input.logger
  );
  let metrics: DeliveryQueueMetrics | null = null;
  const issuance = new PeriodicJobRunner({
    name: "issuance",
    intervalMs: input.settings.pollIntervalMs,
    logger: input.logger,
    canRun: () => input.readiness.canRun("ISSUANCE"),
    execute: async () => {
      await worker.tick();
    }
  });
  const issuanceDeadlineSweep = new PeriodicJobRunner({
    name: "issuanceDeadlineSweep",
    intervalMs: input.settings.pollIntervalMs,
    logger: input.logger,
    canRun: () => input.readiness.canRun("DEADLINE_SWEEP"),
    execute: async () => {
      await sweeper.tick();

      if (input.measureQueue) {
        metrics = await input.measureQueue();
      }
    }
  });

  return {
    worker,
    issuance,
    issuanceDeadlineSweep,
    queueMetrics: () => metrics,
    async stop() {
      worker.stop();
      await Promise.all([issuance.stop(), issuanceDeadlineSweep.stop()]);
    }
  };
}
