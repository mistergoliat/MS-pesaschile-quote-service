import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import type { QuoteClock } from "../../infrastructure/persistence/postgres/quote-clock";
import { databaseClock } from "../../infrastructure/persistence/postgres/quote-clock";
import { getVisibleDelivery, requestEmailDelivery } from "../../infrastructure/persistence/postgres/quote-v2-deliveries";
import type { BusinessRouteRegistrar } from "./index";
import { quoteIdOf, resultOf, validateHeaders, validateRead } from "./v2-quote-route";

/**
 * V2 email delivery routes (R1.6A): request and read only.
 *
 * `POST /v2/quotes/{quoteId}/deliveries/email` is the ONLY operation that can
 * cause an email (Domain D-3, §10.1). In R1.6A it only queues a durable
 * `pending` delivery: no mail port is passed here (only whether one is
 * configured), and no worker exists yet. Order: 400 headers/params → 401 →
 * 403 `quotes:delivery:email` (scope only; `principalType` grants nothing) →
 * binding → 503 `email_provider` when not configured → 404 visibility → 422
 * → 409 → accept (see `requestEmailDelivery`).
 *
 * Readiness: these routes sit behind the existing global business gate
 * (database, schema, storage, renderer). Queueing only needs persistence; the
 * capability-specific gate is R1.6D (pre-flight audit §21).
 */
export function v2DeliveryRoutes(
  database: PostgresDatabase,
  options: {
    /** Whether a mail sender is composed (src/app.ts). The port itself is never passed to a route. */
    readonly emailDeliveryEnabled: boolean;
    readonly clock?: QuoteClock | undefined;
  }
): BusinessRouteRegistrar {
  const clock = options.clock ?? databaseClock;

  return (app) => {
    app.post(
      "/v2/quotes/:quoteId/deliveries/email",
      { config: { requiredScope: "quotes:delivery:email" }, preValidation: validateHeaders },
      async (request, reply) => {
        const outcome = await requestEmailDelivery(database, quoteIdOf(request), {
          principal: request.principal!,
          body: request.body,
          rawIdempotencyKey: request.headers["idempotency-key"] as string,
          correlationId: (request.headers["x-correlation-id"] as string | undefined) ?? null,
          clock,
          emailDeliveryEnabled: options.emailDeliveryEnabled
        });
        const delivery = resultOf(outcome, "quote.delivery.email", reply);

        return reply
          .header("Location", `/v2/quotes/${delivery.quoteId}/deliveries/${delivery.deliveryId}`)
          .code(202)
          .send(delivery);
      }
    );

    app.get(
      "/v2/quotes/:quoteId/deliveries/:deliveryId",
      { config: { requiredScope: "quotes:read" }, preValidation: validateRead(null) },
      async (request) =>
        getVisibleDelivery(database, request.principal!, quoteIdOf(request), (request.params as { deliveryId: string }).deliveryId)
    );
  };
}
