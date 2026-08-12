import type {
  QuoteDeliveryListResult
} from "../application/quote-delivery/ports/quote-delivery-repository";
import type { QuoteDeliveryState } from "../domain";

export interface PublicQuoteDeliveryDto {
  readonly deliveryId: string;
  readonly quoteId: string;
  readonly channel: QuoteDeliveryState["channel"];
  readonly recipient: string;
  readonly status: QuoteDeliveryState["status"];
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly actor: QuoteDeliveryState["actor"];
  readonly source: QuoteDeliveryState["source"];
  readonly timestamps: {
    readonly createdAt: string;
    readonly processingAt: string | null;
    readonly sentAt: string | null;
    readonly failedAt: string | null;
    readonly nextAttemptAt: string | null;
  };
}

export interface PublicQuoteDeliveryListDto {
  readonly items: readonly PublicQuoteDeliveryDto[];
  readonly pagination: QuoteDeliveryListResult["pagination"];
}

export function toPublicQuoteDeliveryDto(delivery: QuoteDeliveryState): PublicQuoteDeliveryDto {
  return {
    deliveryId: delivery.deliveryId,
    quoteId: delivery.quoteId,
    channel: delivery.channel,
    recipient: delivery.recipient,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    providerMessageId: delivery.providerMessageId,
    failureCode: delivery.failureCode,
    failureMessage: delivery.failureMessage,
    actor: delivery.actor,
    source: delivery.source,
    timestamps: {
      createdAt: delivery.createdAt,
      processingAt: delivery.processingAt,
      sentAt: delivery.sentAt,
      failedAt: delivery.failedAt,
      nextAttemptAt: delivery.nextAttemptAt
    }
  };
}

export function toPublicQuoteDeliveryListDto(
  result: QuoteDeliveryListResult
): PublicQuoteDeliveryListDto {
  return {
    items: result.items.map(toPublicQuoteDeliveryDto),
    pagination: result.pagination
  };
}
