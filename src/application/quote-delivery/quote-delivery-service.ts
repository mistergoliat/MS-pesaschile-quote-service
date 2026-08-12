import crypto from "node:crypto";

import {
  normalizeEmailAddress,
  QuoteDelivery,
  type ActorRefInput,
  type QuoteDeliveryState,
  type SourceRefInput
} from "../../domain";
import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "../quote/errors";
import { createCanonicalRequestHash } from "../quote/canonical-json";
import type { QuoteAuditEventRecord } from "../quote/ports/quote-repository";
import type {
  QuoteDeliveryListInput,
  QuoteDeliveryListResult,
  QuoteDeliveryOutboxState,
  QuoteDeliveryQuoteRecord,
  QuoteDeliveryRepository
} from "./ports/quote-delivery-repository";

export interface SendQuoteEmailCommand {
  readonly quoteId: string;
  readonly recipient?: string;
  readonly actor: ActorRefInput;
  readonly source: SourceRefInput;
  readonly requestedAt: string;
  readonly idempotencyKey: string;
}

export interface QuoteDeliveryOperationResult {
  readonly delivery: QuoteDeliveryState;
}

function buildRequestHashPayload(command: {
  readonly quoteId: string;
  readonly recipient: string;
  readonly actor: ActorRefInput;
  readonly source: SourceRefInput;
}): string {
  return createCanonicalRequestHash({
    operation: "send_quote_email",
    quoteId: command.quoteId,
    recipient: command.recipient,
    actor: command.actor,
    source: command.source
  });
}

function buildAuditEvent(input: Omit<QuoteAuditEventRecord, "payloadSnapshot"> & {
  readonly payloadSnapshot: Record<string, unknown>;
}): QuoteAuditEventRecord {
  return input;
}

function buildIdempotencyCompletion(
  command: SendQuoteEmailCommand,
  result: QuoteDeliveryOperationResult
) {
  return {
    idempotencyKey: command.idempotencyKey,
    operationName: "send_quote_email",
    resourceType: "quote_delivery" as const,
    resourceId: result.delivery.deliveryId,
    responseCode: "quote_email_delivery_requested",
    responseBodySnapshot: result,
    completedAt: command.requestedAt
  };
}

function toInitialOutboxState(delivery: QuoteDeliveryState): QuoteDeliveryOutboxState {
  return {
    outboxId: crypto.randomUUID(),
    deliveryId: delivery.deliveryId,
    quoteId: delivery.quoteId,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: delivery.createdAt,
    lockedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.createdAt
  };
}

function resolveRecipient(
  explicitRecipient: string | undefined,
  quote: QuoteDeliveryQuoteRecord
): string {
  if (explicitRecipient) {
    return normalizeEmailAddress(explicitRecipient, "recipient");
  }

  if (!quote.customerEmail) {
    throw new ApplicationError(
      APPLICATION_ERROR_CODES.quoteEmailRecipientMissing,
      "Quote does not have a recipient email address",
      {
        quoteId: quote.quoteId
      }
    );
  }

  return normalizeEmailAddress(quote.customerEmail, "customerSnapshot.email");
}

function assertQuoteDeliverable(quote: QuoteDeliveryQuoteRecord): void {
  if (quote.status === "issued" || quote.status === "accepted") {
    return;
  }

  throw new ApplicationError(
    APPLICATION_ERROR_CODES.quoteEmailDeliveryNotAllowed,
    "Quote cannot be delivered by email in its current status",
    {
      quoteId: quote.quoteId,
      status: quote.status
    }
  );
}

export class QuoteDeliveryService {
  constructor(
    private readonly repository: QuoteDeliveryRepository,
    private readonly emailDeliveryAvailable: boolean
  ) {}

  async requestQuoteEmailDelivery(
    command: SendQuoteEmailCommand
  ): Promise<QuoteDeliveryOperationResult> {
    if (!this.emailDeliveryAvailable) {
      throw new ApplicationError(
        APPLICATION_ERROR_CODES.emailDeliveryUnavailable,
        "Email delivery is not available"
      );
    }

    return this.repository.withTransaction(async (transaction) => {
      const quote = await transaction.findQuoteForDelivery(command.quoteId);

      if (!quote) {
        throw new ApplicationError(APPLICATION_ERROR_CODES.quoteNotFound, "Quote not found", {
          quoteId: command.quoteId
        });
      }

      assertQuoteDeliverable(quote);

      if (!quote.issuedDocument) {
        throw new ApplicationError(
          APPLICATION_ERROR_CODES.quoteEmailDeliveryNotAllowed,
          "Quote does not have issued document artifacts",
          {
            quoteId: quote.quoteId
          }
        );
      }

      let resolvedRecipient: string;

      try {
        resolvedRecipient = resolveRecipient(command.recipient, quote);
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }

        throw new ApplicationError(
          APPLICATION_ERROR_CODES.invalidEmailRecipient,
          error instanceof Error ? error.message : "Invalid email recipient"
        );
      }

      const claim = await transaction.claimIdempotency({
        idempotencyKey: command.idempotencyKey,
        operationName: "send_quote_email",
        requestHash: buildRequestHashPayload({
          quoteId: quote.quoteId,
          recipient: resolvedRecipient,
          actor: command.actor,
          source: command.source
        }),
        expiresAt: new Date(Date.parse(command.requestedAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (claim.kind === "replay") {
        return claim.responseBodySnapshot as QuoteDeliveryOperationResult;
      }

      const delivery = QuoteDelivery.createPending({
        deliveryId: crypto.randomUUID(),
        quoteId: quote.quoteId,
        recipient: resolvedRecipient,
        actor: command.actor,
        source: {
          system: command.source.system,
          correlationId: command.source.correlationId ?? null
        },
        createdAt: command.requestedAt
      }).toSnapshot();
      const result = {
        delivery
      } satisfies QuoteDeliveryOperationResult;

      await transaction.persistRequestedDelivery({
        delivery,
        outbox: toInitialOutboxState(delivery),
        auditEvents: [
          buildAuditEvent({
            quoteId: quote.quoteId,
            quoteNumber: quote.quoteNumber,
            action: "email_delivery_requested",
            fromStatus: quote.status,
            toStatus: quote.status,
            actorType: command.actor.type,
            actorId: command.actor.id,
            sourceSystem: command.source.system,
            correlationId: command.source.correlationId ?? null,
            idempotencyKey: command.idempotencyKey,
            eventAt: command.requestedAt,
            payloadSnapshot: {
              deliveryId: delivery.deliveryId,
              channel: delivery.channel
            }
          })
        ],
        idempotencyCompletion: buildIdempotencyCompletion(command, result)
      });

      return result;
    });
  }

  async listDeliveries(input: QuoteDeliveryListInput): Promise<QuoteDeliveryListResult> {
    return this.repository.listDeliveries(input);
  }

  async findDelivery(quoteId: string, deliveryId: string): Promise<QuoteDeliveryState | null> {
    return this.repository.findDelivery(quoteId, deliveryId);
  }
}
