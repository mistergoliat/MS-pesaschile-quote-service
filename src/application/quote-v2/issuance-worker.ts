import crypto from "node:crypto";

import { classifyAttemptError } from "./attempt-failure";
import type { IssuanceFailpoints } from "./issuance-failpoints";
import type { AttemptFailure, ClaimedAttempt, IssuanceOperationRepository } from "./issuance-operation";
import { SnapshotIntegrityError, type IssuedSnapshot } from "./issued-snapshot";

export { IssuanceAttemptError } from "./attempt-failure";

/*
 * Issuance worker (R1.5B1 core, R1.5B3 real body). Each tick claims at most
 * a bounded number of due operations and runs the attempt body under a
 * fenced, periodically renewed lease. The inline path (after an acceptance
 * commit) runs one specific operation through the same worker. At most ONE
 * attempt runs per process at any time (a single slot shared by the periodic
 * worker and every inline request); PostgreSQL coordinates across processes.
 * Durable truth lives only in the database: losing a tick, a restart or two
 * processes ticking at once changes nothing.
 */

export interface WorkerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface LifecycleView {
  readonly isShuttingDown: boolean;
}

/**
 * Opaque, process-scoped worker instance id, persisted as `lease_owner`.
 * Random per process start (not derived from the host name), not a secret,
 * and well within the 200-character column bound.
 */
export function createWorkerInstanceId(serviceName = "quote-service"): string {
  return `${serviceName.slice(0, 64)}:${process.pid}:${crypto.randomUUID()}`;
}

export interface AttemptContext {
  readonly attempt: ClaimedAttempt;
  readonly snapshot: IssuedSnapshot;
  /** Aborted when the lease is lost or the worker is stopping: the body must stop acting. */
  readonly signal: AbortSignal;
  /** Request/trace correlation of an inline attempt (audit only); null for the periodic worker. */
  readonly correlationId: string | null;
}

/**
 * What an attempt reports. `succeeded`: the fenced T5 commit applied.
 * `abandoned`: stop without a durable write; the lease expires and the
 * operation is reclaimed. `failed`: classified failure (amendment A5).
 */
export type AttemptOutcome =
  | { readonly kind: "succeeded" }
  | ({ readonly kind: "failed" } & AttemptFailure)
  | { readonly kind: "abandoned" };

export type AttemptBody = (context: AttemptContext) => Promise<AttemptOutcome>;

type LeaseState = "held" | "lost" | "deadline";

/**
 * Per-attempt lease renewal (not a periodic job): a fenced renew every
 * `leaseMs / 3`. A stale fence or the deadline stops it and aborts the
 * attempt's signal; a transient database error is retried on the next beat
 * (if renewal keeps failing the lease simply expires and the operation is
 * reclaimed). The timer is unref'd and never keeps the process alive.
 */
export class LeaseRenewal {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private leaseState: LeaseState = "held";

  constructor(
    private readonly repository: Pick<IssuanceOperationRepository, "renewLease">,
    private readonly attempt: ClaimedAttempt,
    private readonly leaseMs: number,
    private readonly logger: WorkerLogger,
    private readonly failpoints?: IssuanceFailpoints
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): LeaseState {
    return this.leaseState;
  }

  start(): void {
    this.schedule();
  }

  /** Stops renewing and waits for an in-flight renewal; idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.inFlight;
  }

  /** Abort the attempt (shutdown); does not touch the durable lease. */
  abort(): void {
    this.controller.abort();
  }

  /** One fenced renewal now (also driven by the timer). */
  renewNow(): Promise<void> {
    this.inFlight ??= this.renew().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(): void {
    if (this.stopped || this.leaseState !== "held") {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.renewNow().then(() => this.schedule());
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    this.timer.unref();
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.leaseState !== "held") {
      return;
    }

    try {
      await this.failpoints?.reach("lease_renewal", { operationId: this.attempt.operationId, generation: this.attempt.generation });

      if (this.stopped || this.leaseState !== "held") {
        return;
      }

      const result = await this.repository.renewLease(this.attempt);

      if (result.kind === "RENEWED") {
        return;
      }

      this.leaseState = result.kind === "STALE_FENCE" ? "lost" : "deadline";
      this.logger.warn(
        {
          event: "issuance.lease_lost",
          operationId: this.attempt.operationId,
          generation: this.attempt.generation,
          reason: result.kind === "STALE_FENCE" ? "stale_fence" : "deadline_reached"
        },
        "Issuance lease lost"
      );
      this.controller.abort();
    } catch (error) {
      this.logger.warn(
        { event: "issuance.lease_renewal_failed", operationId: this.attempt.operationId, errorName: errorName(error) },
        "Issuance lease renewal failed; retrying"
      );
    }
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export interface IssuanceWorkerConfig {
  readonly leaseOwner: string;
  readonly leaseMs: number;
  /** Upper bound of claims per tick, so a tick (and `stop()`) stays short. */
  readonly maxClaimsPerTick: number;
}

export type RunOperationResult =
  /** This process ran an attempt on the operation (whatever its outcome). */
  | { readonly kind: "ran"; readonly outcome: AttemptOutcome }
  /** The process slot is taken by another attempt, or the worker is stopping. */
  | { readonly kind: "busy" }
  /** Not claimable now: another holder has it, it is not due, or it is no longer current. */
  | { readonly kind: "not_claimed" };

export class IssuanceWorker {
  private stopping = false;
  private current: LeaseRenewal | null = null;
  /** The single per-process attempt slot (periodic worker and inline requests). */
  private slotTaken = false;

  constructor(
    private readonly repository: IssuanceOperationRepository,
    private readonly body: AttemptBody,
    private readonly lifecycle: LifecycleView,
    private readonly config: IssuanceWorkerConfig,
    private readonly logger: WorkerLogger,
    /** Test compositions only (issuance-failpoints.ts); production passes nothing. */
    private readonly failpoints?: IssuanceFailpoints
  ) {}

  /** One trigger: claim and run up to `maxClaimsPerTick` attempts, sequentially. Returns the number of attempts run. */
  async tick(): Promise<number> {
    let attempts = 0;

    while (attempts < this.config.maxClaimsPerTick) {
      // Checked before every claim: a shutting-down process never takes new work.
      if (this.stopping || this.lifecycle.isShuttingDown || this.slotTaken) {
        break;
      }

      this.slotTaken = true;

      try {
        const claim = await this.repository.claimNext(this.config.leaseOwner);

        if (claim.kind === "NONE_AVAILABLE") {
          break;
        }

        attempts += 1;
        await this.runAttempt(claim.attempt, null);
      } finally {
        this.slotTaken = false;
      }
    }

    return attempts;
  }

  /**
   * Inline path: claim and run one specific operation in this process's
   * single slot, through the same claim/fence rules as the periodic worker.
   * Never waits for the slot; a busy slot or an operation claimed elsewhere
   * is reported, not queued.
   */
  async runOperation(operationId: string, correlationId: string | null): Promise<RunOperationResult> {
    if (this.stopping || this.lifecycle.isShuttingDown || this.slotTaken) {
      return { kind: "busy" };
    }

    this.slotTaken = true;

    try {
      const claim = await this.repository.claimOperation(operationId, this.config.leaseOwner);

      if (claim.kind === "NONE_AVAILABLE") {
        return { kind: "not_claimed" };
      }

      return { kind: "ran", outcome: await this.runAttempt(claim.attempt, correlationId) };
    } finally {
      this.slotTaken = false;
    }
  }

  /** No new claims; abort the in-flight attempt (its lease expires, it is never marked succeeded). */
  stop(): void {
    this.stopping = true;
    this.current?.abort();
  }

  private async runAttempt(attempt: ClaimedAttempt, correlationId: string | null): Promise<AttemptOutcome> {
    this.logger.info(
      {
        event: attempt.reclaimed ? "issuance.reclaimed" : "issuance.claimed",
        operationId: attempt.operationId,
        quoteId: attempt.quoteId,
        generation: attempt.generation,
        attempt: attempt.attemptCount
      },
      attempt.reclaimed ? "Issuance operation reclaimed" : "Issuance operation claimed"
    );
    const lease = new LeaseRenewal(this.repository, attempt, this.config.leaseMs, this.logger, this.failpoints);
    this.current = lease;
    lease.start();
    let outcome: AttemptOutcome;

    try {
      if (this.stopping) {
        lease.abort();
      }

      outcome = await this.attemptOutcome(attempt, lease.signal, correlationId);
    } finally {
      await lease.stop();
      this.current = null;
    }

    if (outcome.kind === "succeeded") {
      this.logger.info(
        { event: "issuance.succeeded", operationId: attempt.operationId, quoteId: attempt.quoteId, generation: attempt.generation, attempt: attempt.attemptCount },
        "Quote issued"
      );
      return outcome;
    }

    if (outcome.kind === "abandoned" || lease.state === "lost" || this.stopping) {
      // Lease lost or shutting down: no durable write. The lease expires and
      // the next holder (or the deadline sweep) takes over. A lease that only
      // stopped renewing at the deadline is still ours: the failure below
      // records the terminal state at once.
      return outcome.kind === "abandoned" ? outcome : { kind: "abandoned" };
    }

    const result = await this.repository.failAttempt(attempt, { errorCode: outcome.errorCode, retryable: outcome.retryable, reason: outcome.reason });

    if (result.kind === "FAILED_NON_RETRYABLE") {
      this.logger.error(
        { event: "issuance.failed_non_retryable", operationId: attempt.operationId, generation: attempt.generation, errorCode: outcome.errorCode, reason: outcome.reason },
        "Issuance operation failed (non-retryable); operator action required"
      );
    } else if (result.kind === "RESCHEDULED") {
      this.logger.warn(
        {
          event: "issuance.attempt_failed",
          operationId: attempt.operationId,
          generation: attempt.generation,
          attempt: result.attemptCount,
          errorCode: outcome.errorCode,
          reason: outcome.reason,
          nextAttemptAt: result.nextAttemptAt.toISOString()
        },
        "Issuance attempt failed; rescheduled"
      );
    } else if (result.kind === "DEADLINE_REACHED") {
      this.logger.error(
        { event: "issuance.deadline_failed", operationId: attempt.operationId, generation: attempt.generation, errorCode: outcome.errorCode },
        "Issuance operation failed at its deadline; operator action required"
      );
    } else if (result.kind === "STALE_FENCE") {
      this.logger.warn({ event: "issuance.lease_lost", operationId: attempt.operationId, generation: attempt.generation, reason: "stale_fence" }, "Issuance lease lost");
    }

    return outcome;
  }

  /** Integrity check, then the body. Never throws: every failure becomes a typed attempt failure. */
  private async attemptOutcome(attempt: ClaimedAttempt, signal: AbortSignal, correlationId: string | null): Promise<AttemptOutcome> {
    let snapshot: IssuedSnapshot;
    const checkpoint = { operationId: attempt.operationId, generation: attempt.generation };

    try {
      await this.failpoints?.reach("after_claim", checkpoint);
      snapshot = await this.repository.loadVerifiedSnapshot(attempt.operationId);
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) {
        this.logger.error(
          { event: "issuance.snapshot_integrity_failed", operationId: attempt.operationId, quoteId: attempt.quoteId },
          "Issued snapshot does not match its accepted hash; not rendering"
        );
        return { kind: "failed", ...classifyAttemptError(error) };
      }

      return { kind: "failed", errorCode: "dependency_unavailable", retryable: true, reason: "snapshot_load_failed" };
    }

    try {
      await this.failpoints?.reach("after_snapshot_verified", checkpoint);
      return await this.body({ attempt, snapshot, signal, correlationId });
    } catch (error) {
      return { kind: "failed", ...classifyAttemptError(error) };
    }
  }
}

/** Deadline sweep trigger body: bounded batches, stops between batches when shutting down. */
export class IssuanceDeadlineSweeper {
  constructor(
    private readonly repository: Pick<IssuanceOperationRepository, "failDeadlineExceeded">,
    private readonly lifecycle: LifecycleView,
    private readonly config: { readonly batchSize: number; readonly maxBatchesPerTick: number },
    private readonly logger: WorkerLogger
  ) {}

  async tick(): Promise<number> {
    let total = 0;

    for (let batch = 0; batch < this.config.maxBatchesPerTick && !this.lifecycle.isShuttingDown; batch += 1) {
      const failed = await this.repository.failDeadlineExceeded(this.config.batchSize);

      for (const failure of failed) {
        // Operator alert (T6): one line per operation, ids and codes only.
        this.logger.error(
          {
            event: "issuance.deadline_failed",
            operationId: failure.operationId,
            quoteId: failure.quoteId,
            previousStatus: failure.previousStatus,
            generation: failure.generation,
            errorCode: "issuance_deadline_exceeded"
          },
          "Issuance operation failed at its deadline; operator action required"
        );
      }

      total += failed.length;

      if (failed.length < this.config.batchSize) {
        break;
      }
    }

    return total;
  }
}
