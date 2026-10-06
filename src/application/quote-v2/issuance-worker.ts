import crypto from "node:crypto";

import {
  ISSUANCE_ATTEMPT_ERROR_CODES,
  type ClaimedAttempt,
  type IssuanceAttemptErrorCode,
  type IssuanceOperationRepository
} from "./issuance-operation";
import { SnapshotIntegrityError, type IssuedSnapshot } from "./issued-snapshot";

/*
 * Issuance worker skeleton (R1.5B1). Each tick claims at most a bounded
 * number of due operations, one attempt at a time, and runs the injected
 * attempt body under a fenced, periodically renewed lease. Durable truth
 * lives only in PostgreSQL: losing a tick, a restart or two processes ticking
 * at once changes nothing.
 *
 * B1 deliberately has no success path: the attempt body can only fail or
 * abandon. The real body (load snapshot → render → publish → fenced manifest
 * commit, T5) arrives in B3; until then this worker is not composed into the
 * application (see infrastructure/runtime/issuance-jobs.ts).
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

/** A typed attempt failure; anything else thrown by a body counts as `document_generation_failed`. */
export class IssuanceAttemptError extends Error {
  override readonly name = "IssuanceAttemptError";

  constructor(readonly code: IssuanceAttemptErrorCode) {
    super(`Issuance attempt failed: ${code}`);
  }
}

export interface AttemptContext {
  readonly attempt: ClaimedAttempt;
  readonly snapshot: IssuedSnapshot;
  /** Aborted when the lease is lost or the worker is stopping: the body must stop acting. */
  readonly signal: AbortSignal;
}

/**
 * What an attempt body may report in B1. `abandoned`: stop without a durable
 * write; the lease expires and the operation is reclaimed.
 */
export type AttemptOutcome = { readonly kind: "failed"; readonly errorCode: IssuanceAttemptErrorCode } | { readonly kind: "abandoned" };

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
    private readonly logger: WorkerLogger
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

export class IssuanceWorker {
  private stopping = false;
  private current: LeaseRenewal | null = null;

  constructor(
    private readonly repository: IssuanceOperationRepository,
    private readonly body: AttemptBody,
    private readonly lifecycle: LifecycleView,
    private readonly config: IssuanceWorkerConfig,
    private readonly logger: WorkerLogger
  ) {}

  /** One trigger: claim and run up to `maxClaimsPerTick` attempts, sequentially. Returns the number of attempts run. */
  async tick(): Promise<number> {
    let attempts = 0;

    while (attempts < this.config.maxClaimsPerTick) {
      // Checked before every claim: a shutting-down process never takes new work.
      if (this.stopping || this.lifecycle.isShuttingDown) {
        break;
      }

      const claim = await this.repository.claimNext(this.config.leaseOwner);

      if (claim.kind === "NONE_AVAILABLE") {
        break;
      }

      attempts += 1;
      await this.runAttempt(claim.attempt);
    }

    return attempts;
  }

  /** No new claims; abort the in-flight attempt (its lease expires, it is never marked succeeded). */
  stop(): void {
    this.stopping = true;
    this.current?.abort();
  }

  private async runAttempt(attempt: ClaimedAttempt): Promise<void> {
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
    const lease = new LeaseRenewal(this.repository, attempt, this.config.leaseMs, this.logger);
    this.current = lease;
    lease.start();
    let outcome: AttemptOutcome;

    try {
      if (this.stopping) {
        lease.abort();
      }

      outcome = await this.attemptOutcome(attempt, lease.signal);
    } finally {
      await lease.stop();
      this.current = null;
    }

    if (outcome.kind === "abandoned" || lease.state === "lost" || this.stopping) {
      // Lease lost or shutting down: no durable write. The lease expires and
      // the next holder (or the deadline sweep) takes over. A lease that only
      // stopped renewing at the deadline is still ours: the failure below
      // records the terminal state at once.
      return;
    }

    const result = await this.repository.failAttempt(attempt, outcome.errorCode);

    if (result.kind === "RESCHEDULED") {
      this.logger.warn(
        {
          event: "issuance.attempt_failed",
          operationId: attempt.operationId,
          generation: attempt.generation,
          attempt: result.attemptCount,
          errorCode: outcome.errorCode,
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
  }

  /** Integrity check, then the body. Never throws: every failure becomes a typed attempt failure. */
  private async attemptOutcome(attempt: ClaimedAttempt, signal: AbortSignal): Promise<AttemptOutcome> {
    let snapshot: IssuedSnapshot;

    try {
      snapshot = await this.repository.loadVerifiedSnapshot(attempt.operationId);
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) {
        this.logger.error(
          { event: "issuance.snapshot_integrity_failed", operationId: attempt.operationId, quoteId: attempt.quoteId },
          "Issued snapshot does not match its accepted hash; not rendering"
        );
        return { kind: "failed", errorCode: "document_generation_failed" };
      }

      return { kind: "failed", errorCode: "dependency_unavailable" };
    }

    try {
      return await this.body({ attempt, snapshot, signal });
    } catch (error) {
      const code = error instanceof IssuanceAttemptError && ISSUANCE_ATTEMPT_ERROR_CODES.includes(error.code) ? error.code : "document_generation_failed";
      return { kind: "failed", errorCode: code };
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
