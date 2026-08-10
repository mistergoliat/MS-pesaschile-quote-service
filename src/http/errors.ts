import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodIssue } from "zod";

import { isDomainError, type DomainErrorCode } from "../domain";
import {
  ApplicationError,
  type ApplicationErrorCode
} from "../application/quote/errors";

type HttpErrorCode =
  | DomainErrorCode
  | ApplicationErrorCode
  | "missing_authentication"
  | "invalid_authentication"
  | "document_not_found"
  | "internal_server_error"
  | "validation_error";

interface HttpErrorPayload {
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly statusCode: number;
  readonly code: HttpErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(payload: HttpErrorPayload) {
    super(payload.message);
    this.statusCode = payload.statusCode;
    this.code = payload.code;
    this.details = payload.details;
  }
}

function hasPath(issues: readonly ZodIssue[], path: string): boolean {
  return issues.some((issue) => issue.path.join(".").includes(path));
}

function inferValidationCode(issues: readonly ZodIssue[]): HttpErrorCode {
  if (hasPath(issues, "quoteNumber")) {
    return "invalid_quote_number";
  }

  if (
    hasPath(issues, "quoteId") ||
    hasPath(issues, "revisionRootId") ||
    hasPath(issues, "expectedVersion")
  ) {
    return "invalid_quote_reference";
  }

  if (hasPath(issues, "actor")) {
    return "invalid_actor";
  }

  if (hasPath(issues, "source")) {
    return "invalid_source";
  }

  if (hasPath(issues, "currency")) {
    return "invalid_currency";
  }

  if (hasPath(issues, "customerSnapshot")) {
    return "invalid_customer_snapshot";
  }

  if (hasPath(issues, "quantity")) {
    return "invalid_line_quantity";
  }

  if (hasPath(issues, "unitPrice")) {
    return "invalid_line_price";
  }

  if (hasPath(issues, "taxRate")) {
    return "invalid_tax_rate";
  }

  if (hasPath(issues, "validUntil")) {
    return "invalid_valid_until";
  }

  return "validation_error";
}

export function createValidationError(
  message: string,
  issues?: readonly ZodIssue[]
): HttpError {
  const details =
    issues && issues.length > 0
      ? {
          issues: issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      : undefined;

  return new HttpError({
    statusCode: 400,
    code: issues ? inferValidationCode(issues) : "validation_error",
    message,
    ...(details ? { details } : {})
  });
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  ) {
    return new HttpError({
      statusCode: 413,
      code: "validation_error",
      message: "Request body is too large"
    });
  }

  if (error instanceof ZodError) {
    return createValidationError("Request validation failed", error.issues);
  }

  if (error instanceof ApplicationError) {
    return new HttpError({
      statusCode:
        error.code === "quote_not_found"
          ? 404
          : error.code === "document_generation_failed" || error.code === "document_storage_failed"
            ? 503
          : error.code === "document_issuance_unavailable"
            ? 503
            : 409,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    });
  }

  if (isDomainError(error)) {
    const conflictCodes = new Set<DomainErrorCode>([
      "invalid_quote_status_transition",
      "draft_only_operation",
      "quote_already_terminal",
      "quote_already_superseded",
      "optimistic_concurrency_conflict"
    ]);

    return new HttpError({
      statusCode: conflictCodes.has(error.code) ? 409 : 400,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    });
  }

  return new HttpError({
    statusCode: 500,
    code: "internal_server_error",
    message: "Unexpected server error"
  });
}

export function sendErrorResponse(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  const httpError = toHttpError(error);

  if (httpError.statusCode >= 500) {
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

  return reply.status(httpError.statusCode).send({
    error: {
      code: httpError.code,
      message: httpError.message,
      ...(httpError.details ? { details: httpError.details } : {})
    }
  });
}
