export interface QuoteEmailRetryPolicyDecision {
  readonly retryable: boolean;
  readonly nextAttemptAt: string | null;
  readonly failureCode: string;
  readonly failureMessage: string;
}

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000
] as const;

export class EmailSendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "EmailSendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function resolveNextRetryAt(
  now: string,
  attemptCount: number,
  maxAttempts: number
): string | null {
  if (attemptCount >= maxAttempts) {
    return null;
  }

  const delayIndex = Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1);
  const fallbackDelayMs = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

  if (fallbackDelayMs === undefined) {
    throw new Error("Retry policy is not configured");
  }

  const delayMs = RETRY_DELAYS_MS[delayIndex] ?? fallbackDelayMs;

  return new Date(Date.parse(now) + delayMs).toISOString();
}

export function classifyQuoteEmailFailure(input: {
  readonly error: unknown;
  readonly now: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}): QuoteEmailRetryPolicyDecision {
  const normalized = normalizeFailure(input.error);
  const nextAttemptAt =
    normalized.retryable
      ? resolveNextRetryAt(input.now, input.attemptCount, input.maxAttempts)
      : null;

  return {
    retryable: normalized.retryable && nextAttemptAt !== null,
    nextAttemptAt,
    failureCode: normalized.code,
    failureMessage: normalized.message
  };
}

function normalizeFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof EmailSendError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof Error) {
    return {
      code: "unexpected_email_delivery_error",
      message: error.message,
      retryable: false
    };
  }

  return {
    code: "unexpected_email_delivery_error",
    message: "Unexpected email delivery error",
    retryable: false
  };
}
