/*
 * Delivery execution policy (R1.6B). Owner decision W9 (pre-flight audit §34):
 * at most 6 attempts, delays 1 m / 5 m / 15 m / 1 h / 4 h after each SAFE
 * (provably not accepted) failure, and no retry scheduled past
 * `requested_at + 24 h`. Code-owned constants, not configuration: they define
 * the delivery guarantee. Issuance backoff is deliberately NOT reused.
 *
 * Every instant is a database instant; the schedule is persisted as
 * `next_attempt_at`, so no in-memory timer is authoritative.
 */

export const DELIVERY_MAX_ATTEMPTS = 6;
export const DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** Delay before attempt n+1 after a safe failure of attempt n (n = 1..5). */
export const DELIVERY_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

/** Worker-level codes (the provider codes live in mail-sender-port.ts). */
export const DELIVERY_ERROR_CODES = {
  /** A6.1: the quote expired before provider execution. */
  quoteExpired: "quote_expired",
  /** A6.1 / T8: the quote was cancelled before provider execution. */
  quoteCancelled: "quote_cancelled",
  /** Fail closed: the quote is in a state that can never be emailed (impossible for a queued delivery). */
  quoteNotIssued: "quote_not_issued",
  /** The committed PDF is missing, unreadable, corrupt or not the pinned one. Nothing was sent. */
  documentStorageFailed: "document_storage_failed",
  /** The delivery's data could not be loaded or prepared (database or envelope). Nothing was sent. */
  preparationFailed: "delivery_preparation_failed",
  /** Stopped before the provider call (shutdown, or not enough lease left to finish safely). Nothing was sent. */
  interrupted: "delivery_interrupted",
  /** Expired `sending` lease: a provider call may have happened (sweep → `unknown`). */
  outcomeUnknown: "delivery_outcome_unknown"
} as const;

export type RetryDecision = { readonly kind: "retry"; readonly nextAttemptAt: Date } | { readonly kind: "exhausted" };

/**
 * After a safe (provably not accepted) failure of attempt `attemptCount`
 * (1-based, already counted at claim): the next attempt instant, or
 * `exhausted` when the attempt limit is reached or the next attempt would
 * fall after the retry window. Pure.
 */
export function nextRetry(input: { readonly attemptCount: number; readonly requestedAt: Date; readonly now: Date }): RetryDecision {
  if (input.attemptCount >= DELIVERY_MAX_ATTEMPTS) {
    return { kind: "exhausted" };
  }

  const delay = DELIVERY_RETRY_DELAYS_MS[Math.max(0, input.attemptCount - 1)] ?? DELIVERY_RETRY_DELAYS_MS[DELIVERY_RETRY_DELAYS_MS.length - 1]!;
  const nextAttemptAt = new Date(input.now.getTime() + delay);

  if (nextAttemptAt.getTime() > input.requestedAt.getTime() + DELIVERY_RETRY_WINDOW_MS) {
    return { kind: "exhausted" };
  }

  return { kind: "retry", nextAttemptAt };
}
