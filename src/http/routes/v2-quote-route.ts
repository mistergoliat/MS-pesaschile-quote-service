import type { FastifyReply, FastifyRequest, preValidationHookHandler } from "fastify";

import { isValidIdempotencyKey, type IdempotentOperation } from "../../application/idempotency/idempotency-scope";
import {
  acceptCreateAndIssue,
  type CommandOutcome,
  type QuoteOperationResult
} from "../../infrastructure/persistence/postgres/quote-v2-acceptance";
import { createDraft, issueDraft, updateDraft } from "../../infrastructure/persistence/postgres/quote-v2-drafts";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { authorize } from "../authentication";
import { HttpError } from "../errors";
import type { BusinessRouteRegistrar } from "./index";

const CORRELATION_ID_PATTERN = /^[!-~](?:[ -~]{0,198}[!-~])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Suggested polling delay for an issuing quote (contract `RetryAfter`). */
const ISSUING_RETRY_AFTER_SECONDS = 2;

const invalidRequest = (message: string) => new HttpError({ statusCode: 400, code: "invalid_request", message });

/** 400 checks that precede authentication (Domain §12): headers and path parameters. */
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

  const { quoteId } = request.params as { quoteId?: string };

  if (quoteId !== undefined && !UUID_PATTERN.test(quoteId)) {
    done(invalidRequest("quoteId must be a UUID"));
    return;
  }

  done();
};

function commandInput(request: FastifyRequest) {
  return {
    principal: request.principal!,
    body: request.body,
    rawIdempotencyKey: request.headers["idempotency-key"] as string,
    correlationId: (request.headers["x-correlation-id"] as string | undefined) ?? null
  };
}

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
 * V2 quote mutations. Evaluation order (Domain §12): 400 headers/params →
 * 401 → 403 (incl. the validityOverride scope) → idempotency binding → 404 →
 * 422 → 409 state/version → acceptance. Readiness (503) is enforced earlier
 * by the business context gate.
 */
export function v2QuoteRoutes(database: PostgresDatabase): BusinessRouteRegistrar {
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
  };
}
