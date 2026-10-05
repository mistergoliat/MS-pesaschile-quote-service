import type { FastifyReply, FastifyRequest, preValidationHookHandler } from "fastify";
import { z } from "zod";

import {
  IDEMPOTENT_OPERATIONS,
  isValidIdempotencyKey,
  type IdempotentOperation
} from "../../application/idempotency/idempotency-scope";
import { toFieldErrors } from "../../application/quote-v2/create-quote-request";
import { databaseClock, type QuoteClock } from "../../infrastructure/persistence/postgres/quote-clock";
import {
  acceptCreateAndIssue,
  type CommandOutcome,
  type QuoteOperationResult
} from "../../infrastructure/persistence/postgres/quote-v2-acceptance";
import { cancelQuote } from "../../infrastructure/persistence/postgres/quote-v2-cancel";
import { createDraft, issueDraft, updateDraft } from "../../infrastructure/persistence/postgres/quote-v2-drafts";
import {
  getVisibleOperation,
  getVisibleQuote,
  listVisibleAudit,
  listVisibleQuotes,
  lookupIdempotencyBinding
} from "../../infrastructure/persistence/postgres/quote-v2-reads";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { authorize } from "../authentication";
import { HttpError } from "../errors";
import type { BusinessRouteRegistrar } from "./index";

const CORRELATION_ID_PATTERN = /^[!-~](?:[ -~]{0,198}[!-~])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Suggested polling delay for an issuing quote (contract `RetryAfter`). */
const ISSUING_RETRY_AFTER_SECONDS = 2;

const invalidRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError({ statusCode: 400, code: "invalid_request", message, ...(details ? { details } : {}) });

/** 400 checks on path parameters (`quoteId`, `operationId` are UUIDs). */
function pathParameterError(request: FastifyRequest): HttpError | null {
  const params = request.params as Record<string, string | undefined>;

  for (const name of ["quoteId", "operationId"]) {
    const value = params[name];

    if (value !== undefined && !UUID_PATTERN.test(value)) {
      return invalidRequest(`${name} must be a UUID`);
    }
  }

  return null;
}

/** 400 checks that precede authentication (Domain §12): mutation headers and path parameters. */
const validateHeaders: preValidationHookHandler = (request, _reply, done) => {
  if (!isValidIdempotencyKey(request.headers["idempotency-key"])) {
    done(invalidRequest("Idempotency-Key header is missing or invalid"));
    return;
  }

  const correlationId = request.headers["x-correlation-id"];

  if (correlationId !== undefined && (typeof correlationId !== "string" || !CORRELATION_ID_PATTERN.test(correlationId))) {
    done(invalidRequest("X-Correlation-Id header is invalid"));
    return;
  }

  done(pathParameterError(request) ?? undefined);
};

// ---------- read query parameters (openapi `listQuotesByCorrelation`, `getQuoteAudit`, `lookupIdempotencyKey`) ----------

const systemCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const opaqueReference = z.string().min(1).max(200).regex(/^[!-~](?:[ -~]{0,198}[!-~])?$/);
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const limit = (max: number, fallback: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .refine((value) => value <= max, { message: `limit must be at most ${max}` })
    .default(fallback);

// Query objects are not closed (unknown parameters are ignored); a repeated parameter is invalid.
const listQuerySchema = z
  .object({
    sourceSystem: systemCode,
    externalReferenceType: systemCode.optional(),
    externalReference: opaqueReference.optional(),
    status: z.enum(["draft", "issuing", "issued", "expired", "cancelled"]).optional(),
    limit: limit(50, 20),
    cursor: cursor.optional()
  })
  .refine((value) => (value.externalReferenceType === undefined) === (value.externalReference === undefined), {
    path: ["externalReference"],
    message: "externalReferenceType and externalReference are given together"
  });
const auditQuerySchema = z.object({ limit: limit(100, 50), cursor: cursor.optional() });
const lookupQuerySchema = z.object({ operation: z.enum(IDEMPOTENT_OPERATIONS) });

function parseQuery<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  const parsed = schema.safeParse(request.query);

  if (!parsed.success) {
    throw invalidRequest("A query parameter is missing or invalid", { fields: toFieldErrors(parsed.error) });
  }

  return parsed.data;
}

/** preValidation (before 401/403, Domain §12) for read routes: path parameters, query, optional key header. */
function validateRead(schema: z.ZodType<unknown> | null, options: { idempotencyKey?: boolean } = {}): preValidationHookHandler {
  return (request, _reply, done) => {
    try {
      const pathError = pathParameterError(request);

      if (pathError) {
        throw pathError;
      }

      if (options.idempotencyKey && !isValidIdempotencyKey(request.headers["idempotency-key"])) {
        throw invalidRequest("Idempotency-Key header is missing or invalid");
      }

      if (schema) {
        parseQuery(schema, request);
      }

      done();
    } catch (error) {
      done(error as Error);
    }
  };
}

// ---------- mutations ----------

const quoteIdOf = (request: FastifyRequest) => (request.params as { quoteId: string }).quoteId;

/** `validityOverride` additionally needs the override scope, before any idempotency lookup (security §2). */
function authorizeOverride(request: FastifyRequest): void {
  const body = request.body;

  if (typeof body === "object" && body !== null && "validityOverride" in body) {
    authorize(request.principal!, "quotes:validity:override");
  }
}

/** Unwraps a command outcome: 409 on a conflicting binding, `Idempotent-Replay` on a replay. */
function resultOf<T>(outcome: CommandOutcome<T>, operation: IdempotentOperation, reply: FastifyReply): T {
  if (outcome.kind === "conflict") {
    throw new HttpError({
      statusCode: 409,
      code: "idempotency_key_conflict",
      message: "This Idempotency-Key is already bound to a different request for this operation.",
      details: { operation, boundRequestFingerprint: outcome.boundRequestFingerprint }
    });
  }

  if (outcome.kind === "replayed") {
    void reply.header("Idempotent-Replay", "true");
  }

  return outcome.result;
}

/** Issuance responses: status is a function of the current state (Domain §4.3). */
function sendIssuance(reply: FastifyReply, result: QuoteOperationResult, doneStatus: 200 | 201): FastifyReply {
  if (result.quote.status === "issuing") {
    return reply
      .header("Location", `/v2/operations/${result.operation.operationId}`)
      .header("Retry-After", String(ISSUING_RETRY_AFTER_SECONDS))
      .code(202)
      .send(result);
  }

  if (doneStatus === 201) {
    void reply.header("Location", `/v2/quotes/${result.quote.quoteId}`);
  }

  return reply.code(doneStatus).send(result);
}

/**
 * V2 quote routes. Mutation evaluation order (Domain §12): 400 headers/params →
 * 401 → 403 (incl. the validityOverride scope) → idempotency binding → 404 →
 * 422 → 409 state/version → acceptance. Reads: 400 → 401 → 403 → 404
 * (missing or not visible). Readiness (503) is enforced earlier by the
 * business context gate. `clock` is the single expiry-projection time source.
 */
export function v2QuoteRoutes(database: PostgresDatabase, clock: QuoteClock = databaseClock): BusinessRouteRegistrar {
  const commandInput = (request: FastifyRequest) => ({
    principal: request.principal!,
    body: request.body,
    rawIdempotencyKey: request.headers["idempotency-key"] as string,
    correlationId: (request.headers["x-correlation-id"] as string | undefined) ?? null,
    clock
  });

  return (app) => {
    app.post("/v2/quotes", { config: { requiredScope: "quotes:create" }, preValidation: validateHeaders }, async (request, reply) => {
      authorizeOverride(request);
      const outcome = await acceptCreateAndIssue(database, commandInput(request));
      return sendIssuance(reply, resultOf(outcome, "quote.create_and_issue", reply), 201);
    });

    app.post(
      "/v2/quotes/drafts",
      { config: { requiredScope: "quotes:draft:write" }, preValidation: validateHeaders },
      async (request, reply) => {
        const quote = resultOf(await createDraft(database, commandInput(request)), "quote.draft.create", reply);
        return reply.header("Location", `/v2/quotes/${quote.quoteId}`).code(201).send(quote);
      }
    );

    app.patch(
      "/v2/quotes/:quoteId/draft",
      { config: { requiredScope: "quotes:draft:write" }, preValidation: validateHeaders },
      async (request, reply) => {
        const outcome = await updateDraft(database, quoteIdOf(request), commandInput(request));
        return reply.code(200).send(resultOf(outcome, "quote.draft.update", reply));
      }
    );

    app.post(
      "/v2/quotes/:quoteId/issue",
      { config: { requiredScope: "quotes:issue" }, preValidation: validateHeaders },
      async (request, reply) => {
        authorizeOverride(request);
        const outcome = await issueDraft(database, quoteIdOf(request), commandInput(request));
        return sendIssuance(reply, resultOf(outcome, "quote.issue", reply), 200);
      }
    );

    // Creator only (A4): `quotes:read:any` never reaches the transition; a non-creator gets 404.
    app.post(
      "/v2/quotes/:quoteId/cancel",
      { config: { requiredScope: "quotes:cancel" }, preValidation: validateHeaders },
      async (request, reply) => {
        const outcome = await cancelQuote(database, quoteIdOf(request), commandInput(request));
        return reply.code(200).send(resultOf(outcome, "quote.cancel", reply));
      }
    );

    // ---------- reads (visibility: creator, or `quotes:read:any`) ----------

    app.get("/v2/quotes/:quoteId", { config: { requiredScope: "quotes:read" }, preValidation: validateRead(null) }, async (request) =>
      getVisibleQuote(database, request.principal!, quoteIdOf(request), clock)
    );

    app.get("/v2/quotes", { config: { requiredScope: "quotes:read" }, preValidation: validateRead(listQuerySchema) }, async (request) =>
      listVisibleQuotes(database, request.principal!, parseQuery(listQuerySchema, request), clock)
    );

    app.get(
      "/v2/operations/:operationId",
      { config: { requiredScope: "quotes:read" }, preValidation: validateRead(null) },
      async (request) => getVisibleOperation(database, request.principal!, (request.params as { operationId: string }).operationId)
    );

    app.get(
      "/v2/quotes/:quoteId/audit",
      { config: { requiredScope: "quotes:audit:read" }, preValidation: validateRead(auditQuerySchema) },
      async (request) => listVisibleAudit(database, request.principal!, quoteIdOf(request), parseQuery(auditQuerySchema, request))
    );

    app.get(
      "/v2/idempotency/current",
      { config: { requiredScope: "quotes:read" }, preValidation: validateRead(lookupQuerySchema, { idempotencyKey: true }) },
      async (request) =>
        lookupIdempotencyBinding(
          database,
          request.principal!,
          parseQuery(lookupQuerySchema, request).operation,
          request.headers["idempotency-key"] as string,
          clock
        )
    );
  };
}
