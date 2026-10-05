import { isValidIdempotencyKey } from "../../application/idempotency/idempotency-scope";
import { acceptCreateAndIssue } from "../../infrastructure/persistence/postgres/quote-v2-acceptance";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { authorize } from "../authentication";
import { HttpError } from "../errors";
import type { BusinessRouteRegistrar } from "./index";

const CORRELATION_ID_PATTERN = /^[!-~](?:[ -~]{0,198}[!-~])?$/;
/** Suggested polling delay for an issuing quote (contract `RetryAfter`). */
const ISSUING_RETRY_AFTER_SECONDS = 2;

const invalidRequest = (message: string) => new HttpError({ statusCode: 400, code: "invalid_request", message });

/**
 * POST /v2/quotes — transactional create-and-issue (openapi createAndIssueQuote).
 * Evaluation order (Domain §12): 400 headers → 401 → 403 (incl. the
 * validityOverride scope) → idempotency binding → 422 → acceptance.
 * Readiness (503) is enforced earlier by the business context gate.
 */
export function v2QuoteRoutes(database: PostgresDatabase): BusinessRouteRegistrar {
  return (app) => {
    app.post(
      "/v2/quotes",
      {
        config: { requiredScope: "quotes:create" },
        preValidation: (request, _reply, done) => {
          if (!isValidIdempotencyKey(request.headers["idempotency-key"])) {
            done(invalidRequest("Idempotency-Key header is missing or invalid"));
            return;
          }

          const correlationId = request.headers["x-correlation-id"];

          if (correlationId !== undefined && (typeof correlationId !== "string" || !CORRELATION_ID_PATTERN.test(correlationId))) {
            done(invalidRequest("X-Correlation-Id header is invalid"));
            return;
          }

          done();
        }
      },
      async (request, reply) => {
        const principal = request.principal!;
        const body = request.body;

        if (typeof body === "object" && body !== null && "validityOverride" in body) {
          authorize(principal, "quotes:validity:override");
        }

        const outcome = await acceptCreateAndIssue(database, {
          principal,
          body,
          rawIdempotencyKey: request.headers["idempotency-key"] as string,
          correlationId: (request.headers["x-correlation-id"] as string | undefined) ?? null
        });

        if (outcome.kind === "conflict") {
          throw new HttpError({
            statusCode: 409,
            code: "idempotency_key_conflict",
            message: "This Idempotency-Key is already bound to a different request for this operation.",
            details: { operation: "quote.create_and_issue", boundRequestFingerprint: outcome.boundRequestFingerprint }
          });
        }

        const { quote, operation } = outcome.result;
        const issuing = quote.status === "issuing";

        if (outcome.kind === "replayed") {
          void reply.header("Idempotent-Replay", "true");
        }

        if (issuing) {
          void reply
            .header("Location", `/v2/operations/${operation.operationId}`)
            .header("Retry-After", String(ISSUING_RETRY_AFTER_SECONDS));
        } else {
          void reply.header("Location", `/v2/quotes/${quote.quoteId}`);
        }

        // Status is a function of the current state (Domain §4.3).
        return reply.code(issuing ? 202 : 201).send(outcome.result);
      }
    );
  };
}
