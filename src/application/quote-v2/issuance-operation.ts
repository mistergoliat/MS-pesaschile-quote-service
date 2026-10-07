import type { IssuedSnapshot } from "./issued-snapshot";

/*
 * Durable issuance operation core (R1.5B1): the port the issuance worker
 * drives, its typed results and the issuance retry schedule. Contract:
 * QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md §4, state machine T6/T10.
 *
 * Expected races (another holder reclaimed, the deadline passed, the quote
 * moved on) are results, never exceptions. All time decisions are made with
 * the database clock inside the repository.
 */

/** Attempt failures persisted as `last_error_code` (contract `Operation.attempts.lastErrorCode`). */
export const ISSUANCE_ATTEMPT_ERROR_CODES = ["document_generation_failed", "document_storage_failed", "dependency_unavailable"] as const;
export type IssuanceAttemptErrorCode = (typeof ISSUANCE_ATTEMPT_ERROR_CODES)[number];

/** The terminal code of an operation that reached its deadline (T6). */
export const ISSUANCE_DEADLINE_EXCEEDED = "issuance_deadline_exceeded";

/** Backoff after failed attempt n (§4.2): 5 s, 30 s, 2 min, 10 min, 30 min, then 60 min; the caller caps it at `deadline_at`. */
const BACKOFF_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
const BACKOFF_CEILING_MS = 3_600_000;

export function issuanceBackoffMs(failedAttempt: number): number {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError("failedAttempt must be a positive integer");
  }

  return BACKOFF_SCHEDULE_MS[failedAttempt - 1] ?? BACKOFF_CEILING_MS;
}

/**
 * The fencing token of one attempt. Every worker mutation is conditioned on
 * all of it (plus `status = 'running'`); after a reclaim the old holder's
 * generation no longer matches and its writes have no effect.
 */
export interface OperationFence {
  readonly operationId: string;
  readonly generation: number;
  readonly leaseOwner: string;
}

export interface ClaimedAttempt extends OperationFence {
  readonly quoteId: string;
  readonly attemptCount: number;
  readonly leaseExpiresAt: Date;
  readonly deadlineAt: Date;
  readonly snapshotHash: string;
  /** True when the claim took over a `running` operation whose lease had expired. */
  readonly reclaimed: boolean;
}

export type ClaimResult = { readonly kind: "CLAIMED"; readonly attempt: ClaimedAttempt } | { readonly kind: "NONE_AVAILABLE" };

export type RenewResult =
  | { readonly kind: "RENEWED"; readonly leaseExpiresAt: Date }
  /** Another generation holds (or finished) the operation, or the holder differs. Stop acting. */
  | { readonly kind: "STALE_FENCE" }
  /** Still ours, but the absolute deadline is reached: the lease cannot be extended. */
  | { readonly kind: "DEADLINE_REACHED" };

/**
 * Amendment A5: every attempt failure is classified retryable (back to
 * `pending` with backoff until the deadline) or non-retryable (deterministic
 * for the snapshot and renderer/template version, or an integrity incident:
 * the operation fails at once, T12). The contractual code is unchanged;
 * `reason` is an internal, sanitized label for logs and audit data.
 */
export interface AttemptFailure {
  readonly errorCode: IssuanceAttemptErrorCode;
  readonly retryable: boolean;
  readonly reason: string;
}

export type FailAttemptResult =
  /** `running → pending`; retried at `nextAttemptAt` (≤ deadline). */
  | { readonly kind: "RESCHEDULED"; readonly nextAttemptAt: Date; readonly attemptCount: number }
  /** Non-retryable (A5, T12): the operation is now terminally `failed` with the attempt's code; the quote stays issuing. */
  | { readonly kind: "FAILED_NON_RETRYABLE" }
  /** The deadline had passed: the operation is now terminally `failed` (`issuance_deadline_exceeded`). */
  | { readonly kind: "DEADLINE_REACHED" }
  | { readonly kind: "STALE_FENCE" }
  /** Commit outcome was unknown and the re-read shows nothing was applied; the lease expiry recovers it. */
  | { readonly kind: "NOT_APPLIED" };

export interface DeadlineFailure {
  readonly operationId: string;
  readonly quoteId: string;
  readonly previousStatus: "pending" | "running";
  readonly generation: number;
}

export type OperatorRetryResult =
  | { readonly kind: "RETRY_CREATED"; readonly operationId: string; readonly deadlineAt: Date }
  | { readonly kind: "QUOTE_NOT_FOUND" }
  /**
   * T10 guard not met: the quote is not `issuing`, `failedOperationId` is no
   * longer its current operation (e.g. a concurrent retry won), or the current
   * operation is not `failed`.
   */
  | {
      readonly kind: "INVALID_STATE";
      readonly quoteStatus: string;
      readonly currentOperationId: string | null;
      readonly currentOperationStatus: string | null;
    }
  | { readonly kind: "NOT_APPLIED" };

export interface OperatorRetryInput {
  readonly quoteId: string;
  /** The failed operation the operator decided to retry; guards against acting on a stale view. */
  readonly failedOperationId: string;
  /** Operator principal recorded on the audit event. */
  readonly actorPrincipalId: string;
  /** Machine-readable reason recorded as audit `data.reasonCode` (never free text: audit data is non-PII). */
  readonly reasonCode?: string;
  readonly correlationId?: string | null;
}

/** Operator reason codes: the contract's `reasonCode` shape, so no free text (and no PII) reaches audit data. */
export const OPERATOR_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** What the fenced T5 commit records (everything verified before the call). */
export interface IssuedDocumentInput {
  /** Semantic snapshot hash the PDF was rendered from; must equal the operation's. */
  readonly semanticSnapshotHash: string;
  readonly pdfSha256: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly rendererVersion: string;
  readonly templateVersion: string;
  /** Request/trace correlation of an inline attempt (audit only). */
  readonly correlationId?: string | null;
}

export type CommitIssuedResult =
  /** T5 committed: manifest, operation `succeeded`, quote `issued`, audit `quote.issued`. */
  | { readonly kind: "COMMITTED"; readonly generatedAt: Date }
  /** The fence no longer holds (reclaimed, swept, failed) or the quote is no longer this operation's `issuing` quote: nothing changed. */
  | { readonly kind: "STALE_FENCE" }
  /** Commit outcome was unknown and the re-read could not prove either outcome; abandon (the lease expiry recovers it). */
  | { readonly kind: "NOT_APPLIED" };

export interface IssuanceOperationRepository {
  /** Claims (or reclaims an expired lease of) the next due current operation of an `issuing` quote. */
  claimNext(leaseOwner: string): Promise<ClaimResult>;
  /** Same claim rules, restricted to one operation (inline path after acceptance). */
  claimOperation(operationId: string, leaseOwner: string): Promise<ClaimResult>;
  renewLease(fence: OperationFence): Promise<RenewResult>;
  failAttempt(fence: OperationFence, failure: AttemptFailure): Promise<FailAttemptResult>;
  /** T5: fenced manifest commit after the bytes are published and verified. */
  commitIssued(fence: OperationFence, document: IssuedDocumentInput): Promise<CommitIssuedResult>;
  /** Deadline sweep (T6): terminally fails up to `limit` operations past their deadline without a live lease. */
  failDeadlineExceeded(limit: number): Promise<DeadlineFailure[]>;
  /** T10 operator retry state primitive (no public endpoint). */
  createOperatorRetry(input: OperatorRetryInput): Promise<OperatorRetryResult>;
  /**
   * The operation's issued snapshot, reloaded from the database and checked
   * against the hash frozen at acceptance; throws SnapshotIntegrityError on a
   * mismatch. Called before every attempt body.
   */
  loadVerifiedSnapshot(operationId: string): Promise<IssuedSnapshot>;
}
