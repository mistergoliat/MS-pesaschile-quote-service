import type { PeriodicJobRunner, PeriodicJobStatus } from "./periodic-job-runner";

export type BackgroundJobName = "issuance" | "issuanceDeadlineSweep" | "expiry" | "emailDelivery" | "deliveryOutcomeSweep";

export interface BackgroundJobStatus extends PeriodicJobStatus {
  readonly enabled: boolean;
}

const DISABLED_JOB_STATUS: BackgroundJobStatus = {
  enabled: false,
  lastPollAt: null,
  lastSuccessAt: null,
  lastIterationFailed: false
};

/**
 * Owns the lifecycle of the service's periodic workers. The V1 jobs (V1
 * expiry, V1 email outbox, V1 orphan cleanup) were retired with the V1
 * persistence model in R1.4; the V2 issuance worker and its deadline sweep
 * (R1.5), expiry materialization (R1.5) and email delivery with its
 * expired-lease sweep (R1.6B) register here. Every runner is expected to be
 * built with a readiness `canRun` gate. Runner status is in-memory
 * observability only, never durable work state.
 */
export class BackgroundJobManager {
  constructor(private readonly jobs: Partial<Record<BackgroundJobName, PeriodicJobRunner>> = {}) {}

  status(): Record<BackgroundJobName, BackgroundJobStatus> {
    const toStatus = (runner: PeriodicJobRunner | undefined): BackgroundJobStatus =>
      runner ? { enabled: true, ...runner.status } : DISABLED_JOB_STATUS;

    return {
      issuance: toStatus(this.jobs.issuance),
      issuanceDeadlineSweep: toStatus(this.jobs.issuanceDeadlineSweep),
      expiry: toStatus(this.jobs.expiry),
      emailDelivery: toStatus(this.jobs.emailDelivery),
      deliveryOutcomeSweep: toStatus(this.jobs.deliveryOutcomeSweep)
    };
  }

  start(): void {
    for (const runner of Object.values(this.jobs)) {
      runner.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.jobs).map((runner) => runner.stop()));
  }
}
