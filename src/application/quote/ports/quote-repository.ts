import type {
  ActorType,
  Quote,
  QuoteSnapshot,
  QuoteStatus,
  QuoteSupersessionLink,
  SourceSystem
} from "../../../domain";

export type QuoteAuditAction =
  | "draft_created"
  | "draft_updated"
  | "issued"
  | "accepted"
  | "paid"
  | "cancelled"
  | "expired"
  | "revision_created"
  | "email_delivery_requested"
  | "email_delivery_sent"
  | "email_delivery_failed"
  | "email_delivery_retry_scheduled";

export interface QuoteAuditEventRecord {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly action: QuoteAuditAction;
  readonly fromStatus: QuoteStatus | null;
  readonly toStatus: QuoteStatus | null;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly sourceSystem: SourceSystem;
  readonly correlationId: string | null;
  readonly idempotencyKey: string | null;
  readonly eventAt: string;
  readonly payloadSnapshot: Record<string, unknown>;
}

export interface QuoteAuditEventSnapshot extends QuoteAuditEventRecord {
  readonly auditEventId: string;
}

export interface OffsetPaginationInput {
  readonly limit: number;
  readonly offset: number;
}

export interface QuoteListFilters extends OffsetPaginationInput {
  readonly opportunityId?: string;
  readonly status?: QuoteStatus;
  readonly revisionRootId?: string;
}

export interface QuoteListResult {
  readonly items: readonly QuoteSnapshot[];
  readonly pagination: OffsetPaginationInput & {
    readonly count: number;
  };
}

export interface ExpiredIssuedQuoteCandidateInput {
  readonly now: string;
  readonly limit: number;
}

export interface IssuedDocumentArtifactRecord {
  readonly quoteId: string;
  readonly contentHash: string;
  readonly htmlStorageKey: string;
  readonly htmlSha256: string;
  readonly pdfStorageKey: string;
  readonly pdfSha256: string;
}

export interface QuoteAuditListInput extends OffsetPaginationInput {
  readonly quoteId: string;
}

export interface QuoteAuditListResult {
  readonly items: readonly QuoteAuditEventSnapshot[];
  readonly pagination: OffsetPaginationInput & {
    readonly count: number;
  };
}

export interface IdempotencyClaimInput {
  readonly idempotencyKey: string;
  readonly operationName: string;
  readonly requestHash: string;
  readonly expiresAt: string;
}

export type IdempotencyClaimResult =
  | {
      readonly kind: "claimed";
    }
  | {
      readonly kind: "replay";
      readonly responseCode: string;
      readonly responseBodySnapshot: unknown;
    };

export interface IdempotencyCompletionInput {
  readonly idempotencyKey: string;
  readonly operationName: string;
  readonly resourceType: "quote" | "quote_delivery";
  readonly resourceId: string;
  readonly responseCode: string;
  readonly responseBodySnapshot: unknown;
  readonly completedAt: string;
}

export interface IdempotencyFailureInput {
  readonly idempotencyKey: string;
  readonly operationName: string;
  readonly failedAt: string;
}

export interface PersistNewQuoteInput {
  readonly quote: Quote;
  readonly auditEvents: readonly QuoteAuditEventRecord[];
  readonly idempotencyCompletion: IdempotencyCompletionInput;
}

export interface PersistExistingQuoteInput {
  readonly quote: Quote;
  readonly expectedVersion: number;
  readonly auditEvents: readonly QuoteAuditEventRecord[];
  readonly idempotencyCompletion?: IdempotencyCompletionInput;
}

export interface PersistRevisionInput {
  readonly revision: Quote;
  readonly predecessorLink: QuoteSupersessionLink;
  readonly predecessorExpectedVersion: number;
  readonly auditEvents: readonly QuoteAuditEventRecord[];
  readonly idempotencyCompletion: IdempotencyCompletionInput;
}

export interface QuoteRepositoryTransaction {
  allocateNextQuoteNumber(): Promise<string>;
  findById(quoteId: string): Promise<Quote | null>;
  findByQuoteNumber(quoteNumber: string): Promise<Quote | null>;
  findExpiredIssuedCandidates(input: ExpiredIssuedQuoteCandidateInput): Promise<readonly Quote[]>;
  claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  markIdempotencyFailed(input: IdempotencyFailureInput): Promise<void>;
  persistNewQuote(input: PersistNewQuoteInput): Promise<void>;
  persistExistingQuote(input: PersistExistingQuoteInput): Promise<void>;
  persistRevisionAtomically(input: PersistRevisionInput): Promise<void>;
}

export interface QuoteRepository {
  findById(quoteId: string): Promise<Quote | null>;
  findByQuoteNumber(quoteNumber: string): Promise<Quote | null>;
  listQuotes(filters: QuoteListFilters): Promise<QuoteListResult>;
  listAuditEvents(input: QuoteAuditListInput): Promise<QuoteAuditListResult>;
  listIssuedDocumentArtifacts(): Promise<readonly IssuedDocumentArtifactRecord[]>;
  markIdempotencyFailed(input: IdempotencyFailureInput): Promise<void>;
  withTransaction<T>(work: (transaction: QuoteRepositoryTransaction) => Promise<T>): Promise<T>;
}

export interface QuoteOperationResult {
  readonly quote: QuoteSnapshot;
}

export interface QuoteRevisionOperationResult {
  readonly quote: QuoteSnapshot;
  readonly predecessorLink: QuoteSupersessionLink;
}

