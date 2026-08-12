import type {
  QuoteDeliveryState,
  QuoteStatus
} from "../../../domain";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompletionInput,
  QuoteAuditEventRecord
} from "../../quote/ports/quote-repository";

export interface QuoteDeliveryQuoteDocumentRecord {
  readonly contentHash: string;
  readonly renderVersion: string;
  readonly htmlStorageKey: string;
  readonly htmlSha256: string;
  readonly pdfStorageKey: string;
  readonly pdfSha256: string;
  readonly generatedAt: string;
}

export interface QuoteDeliveryQuoteRecord {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly status: QuoteStatus;
  readonly customerEmail: string | null;
  readonly issuedDocument: QuoteDeliveryQuoteDocumentRecord | null;
}

export interface QuoteDeliveryOutboxState {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly quoteId: string;
  readonly status: "pending" | "processing" | "completed" | "failed";
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly lockedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuoteDeliveryListInput {
  readonly quoteId: string;
  readonly channel?: "email";
  readonly limit: number;
  readonly offset: number;
}

export interface QuoteDeliveryListResult {
  readonly items: readonly QuoteDeliveryState[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly count: number;
  };
}

export interface QuoteEmailDeliveryWorkItem {
  readonly delivery: QuoteDeliveryState;
  readonly outbox: QuoteDeliveryOutboxState;
  readonly quote: QuoteDeliveryQuoteRecord;
}

export interface QuoteDeliveryRepositoryTransaction {
  findQuoteForDelivery(quoteId: string): Promise<QuoteDeliveryQuoteRecord | null>;
  claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  persistRequestedDelivery(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
    readonly idempotencyCompletion: IdempotencyCompletionInput;
  }): Promise<void>;
}

export interface QuoteDeliveryRepository {
  withTransaction<T>(work: (transaction: QuoteDeliveryRepositoryTransaction) => Promise<T>): Promise<T>;
  listDeliveries(input: QuoteDeliveryListInput): Promise<QuoteDeliveryListResult>;
  findDelivery(quoteId: string, deliveryId: string): Promise<QuoteDeliveryState | null>;
  claimPendingEmailDeliveries(input: {
    readonly now: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly QuoteEmailDeliveryWorkItem[]>;
  markDeliverySent(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly sentAt: string;
    readonly providerMessageId?: string | null;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
  }): Promise<void>;
  markDeliveryFailed(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly failedAt: string;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly retryScheduled: boolean;
    readonly nextAttemptAt: string | null;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
  }): Promise<void>;
}
