import type { FastifyReply, FastifyRequest, preValidationHookHandler } from "fastify";
import { z } from "zod";

import {
  IDEMPOTENT_OPERATIONS,
  isValidIdempotencyKey,
  type IdempotentOperation
} from "../../application/idempotency/idempotency-scope";
import { toFieldErrors } from "../../application/quote-v2/create-quote-request";
import type { CommittedArtifactReader } from "../../application/quote-v2/document/artifact-store-port";
import { documentFileName } from "../../application/quote-v2/document/document-file-name";
import type { InlineIssuance } from "../../application/quote-v2/inline-issuance";
import type { IssuanceFailpoints } from "../../application/quote-v2/issuance-failpoints";
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
  getVisibleQuoteDocument,
  listVisibleAudit,
  listVisibleQuotes,
  lookupIdempotencyBinding,
  readIssuanceResult
} from "../../infrastructure/persistence/postgres/quote-v2-reads";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { authorize } from "../authentication";
import { DEPENDENCY_RETRY_AFTER_SECONDS, HttpError } from "../errors";
import type { BusinessRouteRegistrar } from "./index";

const CORRELATION_ID_PATTERN = /^[!-~](?:[ -~]{0,198}[!-~])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Suggested polling delay for an issuing quote (contract `RetryAfter`). */
const ISSUING_RETRY_AFTER_SECONDS = 2;

const invalidRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError({ statusCode: 400, code: "invalid_request", message, ...(details ? { details } : {}) });

/** 400 checks on path parameters (`quoteId`, `operationId`, `deliveryId` are UUIDs). */
function pathParameterError(request: FastifyRequest): HttpError | null {
  const params = request.params as Record<string, string | undefined>;

  for (const name of ["quoteId", "operationId", "deliveryId"]) {
    const value = params[name];

    if (value !== undefined && !UUID_PATTERN.test(value)) {
      return invalidRequest(`${name} must be a UUID`);
    }
  }

  return null;
}

/** 400 checks that precede authentication (Domain §12): mutation headers and path parameters. */
export const validateHeaders: preValidationHookHandler = (request, _reply, done) => {
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
export function validateRead(schema: z.ZodType<unknown> | null, options: { idempotencyKey?: boolean } = {}): preValidationHookHandler {
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

export const quoteIdOf = (request: FastifyRequest) => (request.params as { quoteId: string }).quoteId;

/** `validityOverride` additionally needs the override scope, before any idempotency lookup (security §2). */
function authorizeOverride(request: FastifyRequest): void {
  const body = request.body;

  if (typeof body === "object" && body !== null && "validityOverride" in body) {
    authorize(request.principal!, "quotes:validity:override");
  }
}

/** Unwraps a command outcome: 409 on a conflicting binding, `Idempotent-Replay` on a replay. */
export function resultOf<T>(outcome: CommandOutcome<T>, operation: IdempotentOperation, reply: FastifyReply): T {
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

export { documentFileName };

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
 * (missing or not visible). Dependency readiness (503) is enforced earlier by
 * the business context, per route `config.capability` (R1.6D): issuance
 * (create-and-issue, issue) needs ISSUANCE (storage + renderer), the document
 * read DOCUMENT_READ (storage, never the renderer), everything else
 * PERSISTENCE only. `clock` is the single expiry-projection time source;
 * `issuanceDeadlineMs` is copied onto every operation accepted here.
 *
 * Issuance (create-and-issue, issue): after the acceptance commit a newly
 * accepted quote gets the bounded inline attempt (`inlineIssuance`, sync
 * budget), then the answer is rebuilt from durable state: 201/200 only once
 * the manifest committed (quote `issued`), else 202 while the operation
 * continues. Replays answer the current state without driving issuance.
 *
 * Document (R1.5B4): `GET …/document` serves only the committed manifest's
 * bytes, read once and verified (`documents.readVerified`); it never renders,
 * repairs or writes anything. `failpoints` exist only in test compositions.
 */
export function v2QuoteRoutes(
  database: PostgresDatabase,
  options: {
    readonly issuanceDeadlineMs: number;
    readonly clock?: QuoteClock | undefined;
    readonly inlineIssuance?: InlineIssuance | undefined;
    readonly documents: CommittedArtifactReader;
    readonly failpoints?: IssuanceFailpoints | undefined;
  }
): BusinessRouteRegistrar {
  const clock = options.clock ?? databaseClock;
  const issueInline = async (
    outcome: CommandOutcome<QuoteOperationResult>,
    request: FastifyRequest
  ): Promise<CommandOutcome<QuoteOperationResult>> => {
    if (outcome.kind !== "accepted" || !options.inlineIssuance || outcome.result.quote.status !== "issuing") {
      return outcome;
    }

    const { quoteId, operationId } = { quoteId: outcome.result.quote.quoteId, operationId: outcome.result.operation.operationId };
    await options.failpoints?.reach("after_acceptance_commit", { operationId });
    await options.inlineIssuance.drive(operationId, (request.headers["x-correlation-id"] as string | undefined) ?? null);
    const result = await readIssuanceResult(database, quoteId, operationId, clock);
    await options.failpoints?.reach("before_issuance_response", { operationId });
    return { kind: "accepted", result };
  };
  const commandInput = (request: FastifyRequest) => ({
    principal: request.principal!,
    body: request.body,
    rawIdempotencyKey: request.headers["idempotency-key"] as string,
    correlationId: (request.headers["x-correlation-id"] as string | undefined) ?? null,
    clock,
    issuanceDeadlineMs: options.issuanceDeadlineMs
  });

  return (app) => {
    app.post("/v2/quotes", { config: { requiredScope: "quotes:create", capability: "ISSUANCE" }, preValidation: validateHeaders }, async (request, reply) => {
      authorizeOverride(request);
      const outcome = await issueInline(await acceptCreateAndIssue(database, commandInput(request)), request);
      return sendIssuance(reply, resultOf(outcome, "quote.create_and_issue", reply), 201);
    });

    app.post(
      "/v2/quotes/drafts",
      { config: { requiredScope: "quotes:draft:write", capability: "PERSISTENCE" }, preValidation: validateHeaders },
      async (request, reply) => {
        const quote = resultOf(await createDraft(database, commandInput(request)), "quote.draft.create", reply);
        return reply.header("Location", `/v2/quotes/${quote.quoteId}`).code(201).send(quote);
      }
    );

    app.patch(
      "/v2/quotes/:quoteId/draft",
      { config: { requiredScope: "quotes:draft:write", capability: "PERSISTENCE" }, preValidation: validateHeaders },
      async (request, reply) => {
        const outcome = await updateDraft(database, quoteIdOf(request), commandInput(request));
        return reply.code(200).send(resultOf(outcome, "quote.draft.update", reply));
      }
    );

    app.post(
      "/v2/quotes/:quoteId/issue",
      { config: { requiredScope: "quotes:issue", capability: "ISSUANCE" }, preValidation: validateHeaders },
      async (request, reply) => {
        authorizeOverride(request);
        const outcome = await issueInline(await issueDraft(database, quoteIdOf(request), commandInput(request)), request);
        return sendIssuance(reply, resultOf(outcome, "quote.issue", reply), 200);
      }
    );

    // Creator only (A4): `quotes:read:any` never reaches the transition; a non-creator gets 404.
    app.post(
      "/v2/quotes/:quoteId/cancel",
      { config: { requiredScope: "quotes:cancel", capability: "PERSISTENCE" }, preValidation: validateHeaders },
      async (request, reply) => {
        const outcome = await cancelQuote(database, quoteIdOf(request), commandInput(request));
        return reply.code(200).send(resultOf(outcome, "quote.cancel", reply));
      }
    );

    // ---------- reads (visibility: creator, or `quotes:read:any`) ----------

    app.get("/v2/quotes/:quoteId", { config: { requiredScope: "quotes:read", capability: "PERSISTENCE" }, preValidation: validateRead(null) }, async (request) =>
      getVisibleQuote(database, request.principal!, quoteIdOf(request), clock)
    );

    app.get("/v2/quotes", { config: { requiredScope: "quotes:read", capability: "PERSISTENCE" }, preValidation: validateRead(listQuerySchema) }, async (request) =>
      listVisibleQuotes(database, request.principal!, parseQuery(listQuerySchema, request), clock)
    );

    // Exact committed bytes, verified before sending (Domain §9.3, state machine §4):
    // 409 until a manifest exists; kept after expiry and after cancel-after-issue.
    app.get(
      "/v2/quotes/:quoteId/document",
      { config: { requiredScope: "quotes:document:read", capability: "DOCUMENT_READ" }, preValidation: validateRead(null) },
      async (request, reply) => {
        const document = await getVisibleQuoteDocument(database, request.principal!, quoteIdOf(request), clock);

        if (document.manifest === null) {
          throw new HttpError({
            statusCode: 409,
            code: "document_not_available",
            message: "The quote has no issued document.",
            details: { status: document.status }
          });
        }

        const read = await options.documents.readVerified(document.manifest);

        if (read.status !== "OK") {
          // Operator incident: the immutable record stays as it is; nothing is
          // regenerated or repaired. Ids and the integrity status only.
          request.log.error(
            {
              event: "document.integrity_failed",
              quoteId: document.quoteId,
              documentId: document.manifest.documentId,
              origin: document.manifest.origin,
              integrityStatus: read.status,
              fsCode: read.fsCode
            },
            "Committed document failed verification; not served"
          );
          throw new HttpError({
            statusCode: 503,
            code: "document_storage_failed",
            message: "The stored document is unavailable.",
            retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS
          });
        }

        const pdfSha256 = document.manifest.pdfSha256;
        return reply
          .code(200)
          .header("Content-Type", "application/pdf")
          .header("Content-Length", String(read.bytes.byteLength))
          .header("Content-Disposition", `attachment; filename="${documentFileName(document.quoteNumber)}"`)
          .header("X-Document-Sha256", pdfSha256)
          .header("ETag", `"${pdfSha256}"`)
          // Personal data (security §6): never stored by shared caches.
          .header("Cache-Control", "private, no-store")
          .header("X-Content-Type-Options", "nosniff")
          .send(read.bytes);
      }
    );

    app.get(
      "/v2/operations/:operationId",
      { config: { requiredScope: "quotes:read", capability: "PERSISTENCE" }, preValidation: validateRead(null) },
      async (request) => getVisibleOperation(database, request.principal!, (request.params as { operationId: string }).operationId)
    );

    app.get(
      "/v2/quotes/:quoteId/audit",
      { config: { requiredScope: "quotes:audit:read", capability: "PERSISTENCE" }, preValidation: validateRead(auditQuerySchema) },
      async (request) => listVisibleAudit(database, request.principal!, quoteIdOf(request), parseQuery(auditQuerySchema, request))
    );

    app.get(
      "/v2/idempotency/current",
      { config: { requiredScope: "quotes:read", capability: "PERSISTENCE" }, preValidation: validateRead(lookupQuerySchema, { idempotencyKey: true }) },
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
