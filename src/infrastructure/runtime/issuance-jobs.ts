import type { IssuanceOperationRepository } from "../../application/quote-v2/issuance-operation";
import {
  IssuanceDeadlineSweeper,
  IssuanceWorker,
  type AttemptBody,
  type LifecycleView,
  type WorkerLogger
} from "../../application/quote-v2/issuance-worker";
import type { IssuanceSettings } from "../config/env";
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
 * the timer. Attempts are gated on full readiness (database, schema, storage,
 * renderer, lifecycle); the sweep only on persistence readiness, so an
 * operation still reaches its terminal state during a storage or renderer
 * outage (§4.3 deadline sweep, I15).
 */

export interface IssuanceReadiness {
  isReady(): boolean;
  isPersistenceReady(): boolean;
}

export interface IssuanceJobs {
  readonly worker: IssuanceWorker;
  readonly issuance: PeriodicJobRunner;
  readonly issuanceDeadlineSweep: PeriodicJobRunner;
  /** Stop order for shutdown: no new claims, abort the in-flight attempt, then stop both timers. */
  stop(): Promise<void>;
}

export function createIssuanceJobs(input: {
  readonly repository: IssuanceOperationRepository;
  readonly attemptBody: AttemptBody;
  readonly leaseOwner: string;
  readonly settings: IssuanceSettings;
  readonly readiness: IssuanceReadiness;
  readonly lifecycle: LifecycleView;
  readonly logger: WorkerLogger;
  readonly maxClaimsPerTick?: number;
  readonly sweepBatchSize?: number;
}): IssuanceJobs {
  const worker = new IssuanceWorker(
    input.repository,
    input.attemptBody,
    input.lifecycle,
    { leaseOwner: input.leaseOwner, leaseMs: input.settings.leaseMs, maxClaimsPerTick: input.maxClaimsPerTick ?? 5 },
    input.logger
  );
  const sweeper = new IssuanceDeadlineSweeper(
    input.repository,
    input.lifecycle,
    { batchSize: input.sweepBatchSize ?? 50, maxBatchesPerTick: 4 },
    input.logger
  );
  const issuance = new PeriodicJobRunner({
    name: "issuance",
    intervalMs: input.settings.pollIntervalMs,
    logger: input.logger,
    canRun: () => input.readiness.isReady(),
    execute: async () => {
      await worker.tick();
    }
  });
  const issuanceDeadlineSweep = new PeriodicJobRunner({
    name: "issuanceDeadlineSweep",
    intervalMs: input.settings.pollIntervalMs,
    logger: input.logger,
    canRun: () => input.readiness.isPersistenceReady(),
    execute: async () => {
      await sweeper.tick();
    }
  });

  return {
    worker,
    issuance,
    issuanceDeadlineSweep,
    async stop() {
      worker.stop();
      await Promise.all([issuance.stop(), issuanceDeadlineSweep.stop()]);
    }
  };
}
