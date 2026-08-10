export const APPLICATION_ERROR_CODES = {
  quoteNotFound: "quote_not_found",
  optimisticConcurrencyConflict: "optimistic_concurrency_conflict",
  idempotencyKeyReusedWithDifferentPayload: "idempotency_key_reused_with_different_payload",
  idempotencyRequestInProgress: "idempotency_request_in_progress",
  quoteAlreadySuperseded: "quote_already_superseded",
  documentIssuanceUnavailable: "document_issuance_unavailable"
} as const;

export type ApplicationErrorCode =
  (typeof APPLICATION_ERROR_CODES)[keyof typeof APPLICATION_ERROR_CODES];

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";
  readonly code: ApplicationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

