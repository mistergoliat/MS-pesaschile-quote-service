import {
  DOMAIN_LIMITS,
  QUOTE_DELIVERY_CHANNELS,
  QUOTE_DELIVERY_STATUSES,
} from "./constants";
import type { ActorType } from "./actor-ref";
import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import { ensureNonEmptyText, parseTimestamp } from "./shared";
import { normalizeEmailAddress } from "./email-address";
import type { SourceSystem } from "./source-ref";

export type QuoteDeliveryChannel = (typeof QUOTE_DELIVERY_CHANNELS)[number];
export type QuoteDeliveryStatus = (typeof QUOTE_DELIVERY_STATUSES)[number];

export interface QuoteDeliveryState {
  readonly deliveryId: string;
  readonly quoteId: string;
  readonly channel: QuoteDeliveryChannel;
  readonly recipient: string;
  readonly status: QuoteDeliveryStatus;
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly actor: {
    readonly type: ActorType;
    readonly id: string;
  };
  readonly source: {
    readonly system: SourceSystem;
    readonly correlationId: string | null;
  };
  readonly createdAt: string;
  readonly processingAt: string | null;
  readonly sentAt: string | null;
  readonly failedAt: string | null;
  readonly nextAttemptAt: string | null;
}

function validateStatus(status: string): QuoteDeliveryStatus {
  if ((QUOTE_DELIVERY_STATUSES as readonly string[]).includes(status)) {
    return status as QuoteDeliveryStatus;
  }

  throw new DomainError(DOMAIN_ERROR_CODES.invalidQuoteDelivery, "Invalid delivery status", {
    status
  });
}

function validateChannel(channel: string): QuoteDeliveryChannel {
  if ((QUOTE_DELIVERY_CHANNELS as readonly string[]).includes(channel)) {
    return channel as QuoteDeliveryChannel;
  }

  throw new DomainError(DOMAIN_ERROR_CODES.invalidQuoteDelivery, "Invalid delivery channel", {
    channel
  });
}

function normalizeOptionalText(
  value: string | null,
  field: string,
  maxLength: number
): string | null {
  if (value === null) {
    return null;
  }

  return ensureNonEmptyText(value, {
    field,
    code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
    maxLength
  });
}

export class QuoteDelivery {
  readonly #state: QuoteDeliveryState;

  private constructor(state: QuoteDeliveryState) {
    this.#state = state;
  }

  static createPending(input: {
    readonly deliveryId: string;
    readonly quoteId: string;
    readonly recipient: string;
    readonly actor: QuoteDeliveryState["actor"];
    readonly source: QuoteDeliveryState["source"];
    readonly createdAt: string;
  }): QuoteDelivery {
    return new QuoteDelivery({
      deliveryId: ensureNonEmptyText(input.deliveryId, {
        field: "deliveryId",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
      }),
      quoteId: ensureNonEmptyText(input.quoteId, {
        field: "quoteId",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
      }),
      channel: "email",
      recipient: normalizeEmailAddress(input.recipient, "recipient"),
      status: "pending",
      attemptCount: 0,
      providerMessageId: null,
      failureCode: null,
      failureMessage: null,
      actor: {
        type: input.actor.type,
        id: ensureNonEmptyText(input.actor.id, {
          field: "actor.id",
          code: DOMAIN_ERROR_CODES.invalidActor,
          maxLength: DOMAIN_LIMITS.actor.maxActorIdLength
        })
      },
      source: {
        system: input.source.system,
        correlationId: input.source.correlationId
      },
      createdAt: parseTimestamp(input.createdAt, {
        field: "createdAt",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
      }),
      processingAt: null,
      sentAt: null,
      failedAt: null,
      nextAttemptAt: null
    });
  }

  static rehydrate(input: QuoteDeliveryState): QuoteDelivery {
    return new QuoteDelivery({
      deliveryId: ensureNonEmptyText(input.deliveryId, {
        field: "deliveryId",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
      }),
      quoteId: ensureNonEmptyText(input.quoteId, {
        field: "quoteId",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
      }),
      channel: validateChannel(input.channel),
      recipient: normalizeEmailAddress(input.recipient, "recipient"),
      status: validateStatus(input.status),
      attemptCount: input.attemptCount,
      providerMessageId: normalizeOptionalText(
        input.providerMessageId,
        "providerMessageId",
        DOMAIN_LIMITS.delivery.maxProviderMessageIdLength
      ),
      failureCode: normalizeOptionalText(
        input.failureCode,
        "failureCode",
        DOMAIN_LIMITS.delivery.maxFailureCodeLength
      ),
      failureMessage: normalizeOptionalText(
        input.failureMessage,
        "failureMessage",
        DOMAIN_LIMITS.delivery.maxFailureMessageLength
      ),
      actor: {
        type: input.actor.type,
        id: ensureNonEmptyText(input.actor.id, {
          field: "actor.id",
          code: DOMAIN_ERROR_CODES.invalidActor,
          maxLength: DOMAIN_LIMITS.actor.maxActorIdLength
        })
      },
      source: {
        system: input.source.system,
        correlationId: input.source.correlationId
      },
      createdAt: parseTimestamp(input.createdAt, {
        field: "createdAt",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
      }),
      processingAt: input.processingAt
        ? parseTimestamp(input.processingAt, {
            field: "processingAt",
            code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
          })
        : null,
      sentAt: input.sentAt
        ? parseTimestamp(input.sentAt, {
            field: "sentAt",
            code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
          })
        : null,
      failedAt: input.failedAt
        ? parseTimestamp(input.failedAt, {
            field: "failedAt",
            code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
          })
        : null,
      nextAttemptAt: input.nextAttemptAt
        ? parseTimestamp(input.nextAttemptAt, {
            field: "nextAttemptAt",
            code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
          })
        : null
    });
  }

  markProcessing(processingAt: string): QuoteDelivery {
    if (this.#state.status === "sent") {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        "Sent deliveries cannot return to processing"
      );
    }

    return new QuoteDelivery({
      ...this.#state,
      status: "processing",
      attemptCount: this.#state.attemptCount + 1,
      providerMessageId: null,
      failureCode: null,
      failureMessage: null,
      processingAt: parseTimestamp(processingAt, {
        field: "processingAt",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
      }),
      failedAt: null,
      sentAt: null,
      nextAttemptAt: null
    });
  }

  markSent(input: {
    readonly sentAt: string;
    readonly providerMessageId?: string | null;
  }): QuoteDelivery {
    if (this.#state.status !== "processing") {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        "Only processing deliveries can be marked as sent"
      );
    }

    return new QuoteDelivery({
      ...this.#state,
      status: "sent",
      providerMessageId:
        input.providerMessageId == null
          ? null
          : ensureNonEmptyText(input.providerMessageId, {
              field: "providerMessageId",
              code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
              maxLength: DOMAIN_LIMITS.delivery.maxProviderMessageIdLength
            }),
      failureCode: null,
      failureMessage: null,
      sentAt: parseTimestamp(input.sentAt, {
        field: "sentAt",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
      }),
      failedAt: null,
      nextAttemptAt: null
    });
  }

  markFailed(input: {
    readonly failedAt: string;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly nextAttemptAt?: string | null;
  }): QuoteDelivery {
    if (this.#state.status !== "processing") {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        "Only processing deliveries can fail"
      );
    }

    return new QuoteDelivery({
      ...this.#state,
      status: "failed",
      providerMessageId: null,
      failureCode: ensureNonEmptyText(input.failureCode, {
        field: "failureCode",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        maxLength: DOMAIN_LIMITS.delivery.maxFailureCodeLength
      }),
      failureMessage: ensureNonEmptyText(input.failureMessage, {
        field: "failureMessage",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
        maxLength: DOMAIN_LIMITS.delivery.maxFailureMessageLength
      }),
      failedAt: parseTimestamp(input.failedAt, {
        field: "failedAt",
        code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
      }),
      nextAttemptAt:
        input.nextAttemptAt == null
          ? null
          : parseTimestamp(input.nextAttemptAt, {
              field: "nextAttemptAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteDelivery
            }),
      sentAt: null
    });
  }

  toSnapshot(): QuoteDeliveryState {
    return {
      ...this.#state,
      actor: {
        ...this.#state.actor
      },
      source: {
        ...this.#state.source
      }
    };
  }
}
