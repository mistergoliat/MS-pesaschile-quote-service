import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { QuoteRequestRejected, REJECTION_STATUS } from "../application/quote-v2/create-quote-request";
import { CommitOutcomeUnknownError } from "../infrastructure/persistence/postgres/postgres";
import {
  isDatabaseUnavailableError,
  isSchemaNotReadyError
} from "../infrastructure/persistence/postgres/postgres-errors";

/** Seconds a client should wait before retrying a 503 caused by dependency state. */
export const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

type HttpErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "internal_error"
  | "validation_error"
  | "arithmetic_mismatch"
  | "idempotency_key_conflict"
  | "quote_not_found"
  | "version_conflict"
  | "invalid_state_transition"
  | "operation_in_progress"
  | "payload_too_large"
  | "dependency_unavailable"
  | "schema_not_ready";

interface HttpErrorPayload {
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly statusCode: number;
  readonly code: HttpErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(payload: HttpErrorPayload) {
    super(payload.message);
    this.statusCode = payload.statusCode;
    this.code = payload.code;
    this.details = payload.details;
    this.retryAfterSeconds = payload.retryAfterSeconds;
  }
}

export function createDependencyUnavailableError(dependency: string): HttpError {
  return new HttpError({
    statusCode: 503,
    code: "dependency_unavailable",
    message: "A required dependency is unavailable; nothing was committed.",
    details: {
      dependency,
      retryable: true
    },
    retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS
  });
}

export function createSchemaNotReadyError(): HttpError {
  return new HttpError({
    statusCode: 503,
    code: "schema_not_ready",
    message: "The database schema is not at the expected migration head.",
    retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS
  });
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  // Never claim "nothing was committed" when COMMIT itself failed: the caller
  // must reconcile by replaying with the same Idempotency-Key.
  if (error instanceof CommitOutcomeUnknownError) {
    return new HttpError({
      statusCode: 500,
      code: "internal_error",
      message: "The outcome of the request is unknown; retry it with the same Idempotency-Key."
    });
  }

  if (error instanceof QuoteRequestRejected) {
    return new HttpError({ statusCode: REJECTION_STATUS[error.code], code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
  }

  const fastifyCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";

  if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new HttpError({ statusCode: 413, code: "payload_too_large", message: "Request body is too large" });
  }

  // Malformed JSON, unsupported media type and other request-parsing failures.
  if (fastifyCode.startsWith("FST_ERR_CTP_") || fastifyCode === "FST_ERR_VALIDATION") {
    return new HttpError({ statusCode: 400, code: "invalid_request", message: "The request could not be parsed" });
  }

  // A request that raced a dependency failure past the readiness gate must
  // still fail as a retryable 503, never as a raw driver error or a 500.
  if (isDatabaseUnavailableError(error)) {
    return createDependencyUnavailableError("database");
  }

  if (isSchemaNotReadyError(error)) {
    return createSchemaNotReadyError();
  }

  if (error instanceof ZodError) {
    return new HttpError({
      statusCode: 400,
      code: "validation_error",
      message: "Request validation failed",
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  return new HttpError({
    statusCode: 500,
    code: "internal_error",
    message: "Unexpected server error"
  });
}

export function sendErrorResponse(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  const httpError = toHttpError(error);

  if (httpError.code === "dependency_unavailable" || httpError.code === "schema_not_ready") {
    // Dependency state is already logged on transition by the monitor; the
    // raw driver error may carry host details, so it is not logged here.
    request.log.warn(
      {
        code: httpError.code,
        requestId: request.id,
        route: request.routeOptions.url
      },
      "Request rejected: dependencies not ready"
    );
  } else if (httpError.statusCode >= 500) {
    request.log.error(
      {
        err: error,
        requestId: request.id,
        route: request.routeOptions.url
      },
      "Unexpected request failure"
    );
  } else if (httpError.statusCode >= 400) {
    request.log.warn(
      {
        code: httpError.code,
        requestId: request.id,
        route: request.routeOptions.url
      },
      "Handled request failure"
    );
  }

  if (httpError.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(httpError.retryAfterSeconds));
  }

  return reply.status(httpError.statusCode).send({
    error: {
      code: httpError.code,
      message: httpError.message,
      requestId: request.id,
      ...(httpError.details ? { details: httpError.details } : {})
    }
  });
}
