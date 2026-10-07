import crypto from "node:crypto";

import type { PoolClient } from "pg";

import type { AuthenticatedPrincipal } from "../../../application/auth/principal";
import { QuoteRequestRejected } from "../../../application/quote-v2/create-quote-request";
import {
  emailDeliveryRequestSchema,
  EmailProviderDisabledError,
  maskRecipient,
  resolveRecipient
} from "../../../application/quote-v2/delivery/delivery-request";
import { effectiveExpiry } from "../../../application/quote-v2/expiry";
import { answerFromBinding, appendAudit, bind, commandContext, parseRequest, type CommandOutcome } from "./quote-v2-acceptance";
import type { PostgresDatabase } from "./postgres";
import { databaseClock, type QuoteClock } from "./quote-clock";
import { iso, quoteNotFound, visibilityClause, withReadSnapshot, type Json } from "./quote-v2-reads";

/*
 * V2 email delivery request and read (R1.6A). Domain §10, state machine §4,
 * Idempotency §5, security §2–§3, openapi `requestEmailDelivery` /
 * `getDelivery` / `Delivery`.
 *
 * R1.6A SENDS NOTHING. A request durably queues one `pending` delivery; no
 * mail port is reachable from here and no worker exists yet (R1.6B).
 */

export type DeliveryView = Json & { readonly deliveryId: string; readonly quoteId: string; readonly status: string };

interface DeliveryRow {
  delivery_id: string;
  quote_id: string;
  channel: string;
  status: string;
  recipient_masked: string;
  document_sha256: string;
  requested_at: Date;
  sent_at: Date | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  last_error_code: string | null;
}

/**
 * Only public columns are ever selected: the raw recipient address and name,
 * the provider message id, lease/fencing state and retry timing stay
 * internal (openapi `Delivery` is closed).
 */
const DELIVERY_COLUMNS = `d.delivery_id, d.quote_id, d.channel, d.status, d.recipient_masked, d.document_sha256, d.requested_at,
       d.sent_at, d.attempt_count, d.last_attempt_at, d.last_error_code`;

const deliveryView = (d: DeliveryRow): DeliveryView => ({
  deliveryId: d.delivery_id,
  quoteId: d.quote_id,
  channel: d.channel,
  status: d.status,
  recipientMasked: d.recipient_masked,
  documentSha256: d.document_sha256,
  requestedAt: iso(d.requested_at)!,
  sentAt: iso(d.sent_at),
  attempts: {
    count: d.attempt_count,
    lastAttemptAt: iso(d.last_attempt_at),
    lastErrorCode: d.last_error_code
  }
});

/** Contract `Delivery` of a delivery known to exist, in its current state. */
async function readDelivery(client: PoolClient, deliveryId: string): Promise<DeliveryView> {
  const { rows } = await client.query<DeliveryRow>(`select ${DELIVERY_COLUMNS} from quote_service.quote_deliveries d where d.delivery_id = $1`, [
    deliveryId
  ]);
  return deliveryView(rows[0]!);
}

export interface EmailDeliveryCommandInput {
  readonly principal: AuthenticatedPrincipal;
  /** The received JSON body, unmodified (fingerprint basis, Idempotency §2). */
  readonly body: unknown;
  readonly rawIdempotencyKey: string;
  /** Request/trace correlation (X-Correlation-Id); audit only. */
  readonly correlationId: string | null;
  /** Effective-status (expiry projection) clock. */
  readonly clock?: QuoteClock | undefined;
  /** True only when a mail sender is composed (src/app.ts). The port itself never reaches this code. */
  readonly emailDeliveryEnabled: boolean;
}

/**
 * `POST /v2/quotes/{quoteId}/deliveries/email`, one transaction. Evaluation
 * order (Domain §10.1 and §12, amendment A6.2: the provider check comes after
 * the binding lookup):
 *
 *   binding lookup (replay → current Delivery / conflict → 409)
 *   → provider configured? (else 503 email_provider; nothing bound)
 *   → quote visible? (else 404 quote_not_found; creator-only rules do NOT
 *     apply: delivery is a read-visibility action, security §2)
 *   → 422 body (closed schema, strict single mailbox)
 *   → 422 delivery_recipient_missing
 *   → 409 invalid_state_transition unless the EFFECTIVE status is `issued`
 *   → insert delivery (`pending`) + audit `quote.delivery.requested` + binding.
 *
 * A bound key replays even after the provider is disabled. The quote row is
 * locked FOR UPDATE before its state is read, so a concurrent cancel (T8,
 * which fails `pending` deliveries in its own transaction) serializes with
 * this request: either the cancel sees the new delivery and fails it, or this
 * request sees `cancelled` and is rejected. The quote itself is never
 * updated (no status, version or document change). The committed manifest's
 * `pdf_sha256` is pinned; nothing is rendered, read from or written to
 * document storage.
 */
export async function requestEmailDelivery(
  database: PostgresDatabase,
  quoteId: string,
  input: EmailDeliveryCommandInput
): Promise<CommandOutcome<DeliveryView>> {
  const context = commandContext(input, "quote.delivery.email", { quoteId });
  const clock = input.clock ?? databaseClock;

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, (bound) => readDelivery(client, bound.deliveryId!));

    if (answered) {
      return answered;
    }

    if (!input.emailDeliveryEnabled) {
      throw new EmailProviderDisabledError();
    }

    const values: unknown[] = [quoteId];
    const visibility = visibilityClause("q", input.principal, values);
    const { rows } = await client.query<{
      status: string;
      valid_until_exclusive: Date | null;
      expired_at: Date | null;
      customer: Record<string, unknown>;
    }>(
      `select q.status, q.valid_until_exclusive, q.expired_at, q.customer
       from quote_service.quotes q where q.quote_id = $1${visibility} for update`,
      values
    );
    const quote = rows[0];

    if (!quote) {
      throw quoteNotFound();
    }

    const request = parseRequest(emailDeliveryRequestSchema, input.body);
    const recipient = resolveRecipient(request, quote.customer);

    if (!recipient) {
      throw new QuoteRequestRejected("delivery_recipient_missing", "No recipient was given and the customer snapshot has no email.");
    }

    const effective = effectiveExpiry(
      { status: quote.status, validUntilExclusive: quote.valid_until_exclusive, expiredAt: quote.expired_at },
      await clock.now(client)
    );

    if (effective.status !== "issued") {
      throw new QuoteRequestRejected("invalid_state_transition", "Only an issued quote can be emailed.", { status: effective.status });
    }

    // `issued` ⇒ committed manifest (deferred trigger quotes_require_document).
    const { rows: manifests } = await client.query<{ pdf_sha256: string | null }>(
      `select pdf_sha256 from quote_service.quote_documents where quote_id = $1`,
      [quoteId]
    );
    const documentSha256 = manifests[0]?.pdf_sha256;

    if (!documentSha256) {
      throw new Error("issued quote has no committed document manifest");
    }

    const deliveryId = crypto.randomUUID();
    // Database time for every instant; the first attempt is due at once (R1.6B worker).
    await client.query(
      `insert into quote_service.quote_deliveries (
         delivery_id, quote_id, origin, channel, status, recipient_email, recipient_name, recipient_masked,
         document_sha256, requested_by_principal_id, generation, attempt_count, next_attempt_at, requested_at, updated_at
       ) values ($1, $2, 'v2', 'email', 'pending', $3, $4, $5, $6, $7, 0, 0, now(), now(), now())`,
      [
        deliveryId,
        quoteId,
        recipient.email,
        recipient.name,
        maskRecipient(recipient.email),
        documentSha256,
        input.principal.principalId
      ]
    );
    await appendAudit(client, {
      quoteId,
      type: "quote.delivery.requested",
      principalId: input.principal.principalId,
      operationId: null,
      correlationId: context.correlationId,
      keyHash: context.scope.keyHash,
      fromStatus: null,
      toStatus: null,
      // Minimal non-PII data (Domain §11): never the recipient, its name or any content.
      data: { deliveryId, documentSha256 }
    });
    await bind(client, context, input.body, { quoteId, operationId: null, deliveryId });

    return { kind: "accepted", result: await readDelivery(client, deliveryId) };
  });
}

/**
 * `GET /v2/quotes/{quoteId}/deliveries/{deliveryId}`: the quote must be
 * visible (404 `quote_not_found` otherwise, existence hiding), then the
 * delivery must exist AND belong to that quote (404 `delivery_not_found`).
 */
export function getVisibleDelivery(
  database: PostgresDatabase,
  principal: AuthenticatedPrincipal,
  quoteId: string,
  deliveryId: string
): Promise<DeliveryView> {
  return withReadSnapshot(database, async (client) => {
    const values: unknown[] = [quoteId];
    const visibility = visibilityClause("q", principal, values);
    const { rowCount } = await client.query(`select 1 from quote_service.quotes q where q.quote_id = $1${visibility}`, values);

    if (rowCount === 0) {
      throw quoteNotFound();
    }

    const { rows } = await client.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} from quote_service.quote_deliveries d where d.delivery_id = $1 and d.quote_id = $2`,
      [deliveryId, quoteId]
    );

    if (rows.length === 0) {
      throw new QuoteRequestRejected("delivery_not_found", "Delivery not found.");
    }

    return deliveryView(rows[0]!);
  });
}
