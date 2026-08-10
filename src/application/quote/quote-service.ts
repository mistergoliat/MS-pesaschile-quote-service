import crypto from "node:crypto";

import {
  Quote,
  isDomainError,
  type ActorRefInput,
  type CustomerSnapshotInput,
  type IssuedDocumentSetInput,
  type QuoteLineInput,
  type QuoteSnapshot,
  type SourceRefInput
} from "../../domain";
import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "./errors";
import { createCanonicalRequestHash } from "./canonical-json";
import type { DocumentIssuancePort } from "./ports/document-issuance-port";
import type {
  IdempotencyCompletionInput,
  QuoteAuditListInput,
  QuoteAuditListResult,
  QuoteAuditEventRecord,
  QuoteListFilters,
  QuoteListResult,
  QuoteOperationResult,
  QuoteRepository,
  QuoteRevisionOperationResult
} from "./ports/quote-repository";

type ItemDraftInput = Omit<QuoteLineInput, "lineId"> & {
  readonly lineId?: string;
};

interface CommandMetadata {
  readonly actor: ActorRefInput;
  readonly source: SourceRefInput;
  readonly idempotencyKey: string;
  readonly requestHashPayload?: unknown;
}

export interface CreateDraftQuoteCommand extends CommandMetadata {
  readonly opportunityId: string;
  readonly customerId?: string | null;
  readonly conversationId?: string | null;
  readonly currency: "CLP";
  readonly customerSnapshot: CustomerSnapshotInput;
  readonly items: readonly ItemDraftInput[];
  readonly validUntil: string;
  readonly createdAt: string;
}

export interface UpdateDraftQuoteCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly customerSnapshot: CustomerSnapshotInput;
  readonly items: readonly ItemDraftInput[];
  readonly validUntil: string;
  readonly updatedAt: string;
}

export interface IssueQuoteCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly issuedDocument: IssuedDocumentSetInput;
  readonly issuedAt: string;
}

export interface AcceptQuoteCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly acceptedAt: string;
}

export interface MarkQuotePaidCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly paidAt: string;
}

export interface CancelQuoteCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly cancelledAt: string;
}

export interface ExpireQuoteCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly now: string;
}

export interface CreateQuoteRevisionCommand extends CommandMetadata {
  readonly quoteId: string;
  readonly expectedVersion: number;
  readonly createdAt: string;
  readonly validUntil?: string;
}

function withGeneratedLineIds(items: readonly ItemDraftInput[]): QuoteLineInput[] {
  return items.map((item) => ({
    ...item,
    lineId: item.lineId ?? crypto.randomUUID()
  }));
}

function regenerateLineIds(quote: Quote): Quote {
  const snapshot = quote.toSnapshot();

  return Quote.rehydrate({
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      lineId: crypto.randomUUID()
    }))
  });
}

function normalizeApplicationError(error: unknown): never {
  if (!isDomainError(error)) {
    throw error;
  }

  if (error.code === "optimistic_concurrency_conflict") {
    throw new ApplicationError(
      APPLICATION_ERROR_CODES.optimisticConcurrencyConflict,
      error.message,
      error.details
    );
  }

  if (error.code === "quote_already_superseded") {
    throw new ApplicationError(
      APPLICATION_ERROR_CODES.quoteAlreadySuperseded,
      error.message,
      error.details
    );
  }

  throw error;
}

function buildAuditEvent(
  input: Omit<QuoteAuditEventRecord, "payloadSnapshot"> & {
    readonly payloadSnapshot: Record<string, unknown>;
  }
): QuoteAuditEventRecord {
  return input;
}

function buildCommandRequestHash(command: CommandMetadata): string {
  return createCanonicalRequestHash(command.requestHashPayload ?? command);
}

function buildIdempotencyCompletion(
  operationName: string,
  idempotencyKey: string,
  quote: QuoteSnapshot,
  responseCode: string,
  completedAt: string
): IdempotencyCompletionInput {
  return {
    idempotencyKey,
    operationName,
    resourceType: "quote",
    resourceId: quote.quoteId,
    responseCode,
    responseBodySnapshot: {
      quote
    } satisfies QuoteOperationResult,
    completedAt
  };
}

function buildRevisionIdempotencyCompletion(
  operationName: string,
  idempotencyKey: string,
  result: QuoteRevisionOperationResult,
  responseCode: string,
  completedAt: string
): IdempotencyCompletionInput {
  return {
    idempotencyKey,
    operationName,
    resourceType: "quote",
    resourceId: result.quote.quoteId,
    responseCode,
    responseBodySnapshot: result,
    completedAt
  };
}

export class QuoteService {
  constructor(private readonly repository: QuoteRepository) {}

  async createDraft(command: CreateDraftQuoteCommand): Promise<QuoteOperationResult> {
    return this.repository.withTransaction(async (transaction) => {
      const operationName = "create_draft_quote";
      const claim = await transaction.claimIdempotency({
        idempotencyKey: command.idempotencyKey,
        operationName,
        requestHash: buildCommandRequestHash(command),
        expiresAt: new Date(Date.parse(command.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (claim.kind === "replay") {
        return claim.responseBodySnapshot as QuoteOperationResult;
      }

      const quote = Quote.createDraft({
        quoteId: crypto.randomUUID(),
        quoteNumber: await transaction.allocateNextQuoteNumber(),
        opportunityId: command.opportunityId,
        ...(command.customerId !== undefined ? { customerId: command.customerId } : {}),
        ...(command.conversationId !== undefined
          ? { conversationId: command.conversationId }
          : {}),
        actor: command.actor,
        source: command.source,
        currency: command.currency,
        customerSnapshot: command.customerSnapshot,
        items: withGeneratedLineIds(command.items),
        validUntil: command.validUntil,
        createdAt: command.createdAt
      });

      const result = {
        quote: quote.toSnapshot()
      } satisfies QuoteOperationResult;

      await transaction.persistNewQuote({
        quote,
        auditEvents: [
          buildAuditEvent({
            quoteId: quote.quoteId,
            quoteNumber: quote.quoteNumber,
            action: "draft_created",
            fromStatus: null,
            toStatus: quote.status,
            actorType: command.actor.type,
            actorId: command.actor.id,
            sourceSystem: command.source.system,
            correlationId: command.source.correlationId ?? null,
            idempotencyKey: command.idempotencyKey,
            eventAt: command.createdAt,
            payloadSnapshot: {
              lineCount: quote.items.length,
              currency: quote.currency,
              total: quote.pricing.total,
              validUntil: quote.validUntil
            }
          })
        ],
        idempotencyCompletion: buildIdempotencyCompletion(
          operationName,
          command.idempotencyKey,
          result.quote,
          "quote_created",
          command.createdAt
        )
      });

      return result;
    });
  }

  async updateDraft(command: UpdateDraftQuoteCommand): Promise<QuoteOperationResult> {
    return this.mutateExistingQuote({
      command,
      operationName: "update_draft_quote",
      responseCode: "quote_updated",
      loadTimestamp: command.updatedAt,
      mutate: (quote) =>
        quote.updateDraft({
          customerSnapshot: command.customerSnapshot,
          items: withGeneratedLineIds(command.items),
          validUntil: command.validUntil,
          updatedAt: command.updatedAt,
          expectedVersion: command.expectedVersion
        }),
      buildAudit: (quoteBefore, quoteAfter) =>
        buildAuditEvent({
          quoteId: quoteAfter.quoteId,
          quoteNumber: quoteAfter.quoteNumber,
          action: "draft_updated",
          fromStatus: quoteBefore.status,
          toStatus: quoteAfter.status,
          actorType: command.actor.type,
          actorId: command.actor.id,
          sourceSystem: command.source.system,
          correlationId: command.source.correlationId ?? null,
          idempotencyKey: command.idempotencyKey,
          eventAt: command.updatedAt,
          payloadSnapshot: {
            lineCount: quoteAfter.items.length,
            total: quoteAfter.pricing.total,
            validUntil: quoteAfter.validUntil
          }
        })
    });
  }

  async issueQuote(command: IssueQuoteCommand): Promise<QuoteOperationResult> {
    return this.mutateExistingQuote({
      command,
      operationName: "issue_quote",
      responseCode: "quote_issued",
      loadTimestamp: command.issuedAt,
      mutate: (quote) =>
        quote.issue({
          issuedDocument: command.issuedDocument,
          issuedAt: command.issuedAt,
          expectedVersion: command.expectedVersion
        }),
      buildAudit: (quoteBefore, quoteAfter) =>
        buildAuditEvent({
          quoteId: quoteAfter.quoteId,
          quoteNumber: quoteAfter.quoteNumber,
          action: "issued",
          fromStatus: quoteBefore.status,
          toStatus: quoteAfter.status,
          actorType: command.actor.type,
          actorId: command.actor.id,
          sourceSystem: command.source.system,
          correlationId: command.source.correlationId ?? null,
          idempotencyKey: command.idempotencyKey,
          eventAt: command.issuedAt,
          payloadSnapshot: {
            status: quoteAfter.status,
            total: quoteAfter.pricing.total,
            validUntil: quoteAfter.validUntil
          }
        })
    });
  }

  async acceptQuote(command: AcceptQuoteCommand): Promise<QuoteOperationResult> {
    return this.transitionQuote({
      command,
      operationName: "accept_quote",
      responseCode: "quote_accepted",
      timestamp: command.acceptedAt,
      mutate: (quote) =>
        quote.accept({
          acceptedAt: command.acceptedAt,
          expectedVersion: command.expectedVersion
        }),
      action: "accepted",
      payloadSnapshot: {
        acceptedAt: command.acceptedAt
      }
    });
  }

  async markQuotePaid(command: MarkQuotePaidCommand): Promise<QuoteOperationResult> {
    return this.transitionQuote({
      command,
      operationName: "mark_quote_paid",
      responseCode: "quote_paid",
      timestamp: command.paidAt,
      mutate: (quote) =>
        quote.markPaid({
          paidAt: command.paidAt,
          expectedVersion: command.expectedVersion
        }),
      action: "paid",
      payloadSnapshot: {
        paidAt: command.paidAt
      }
    });
  }

  async cancelQuote(command: CancelQuoteCommand): Promise<QuoteOperationResult> {
    return this.transitionQuote({
      command,
      operationName: "cancel_quote",
      responseCode: "quote_cancelled",
      timestamp: command.cancelledAt,
      mutate: (quote) =>
        quote.cancel({
          cancelledAt: command.cancelledAt,
          expectedVersion: command.expectedVersion
        }),
      action: "cancelled",
      payloadSnapshot: {
        cancelledAt: command.cancelledAt
      }
    });
  }

  async expireQuote(command: ExpireQuoteCommand): Promise<QuoteOperationResult> {
    return this.transitionQuote({
      command,
      operationName: "expire_quote",
      responseCode: "quote_expired",
      timestamp: command.now,
      mutate: (quote) =>
        quote.expire({
          now: command.now,
          expectedVersion: command.expectedVersion
        }),
      action: "expired",
      payloadSnapshot: {
        expiredAt: command.now
      }
    });
  }

  async createRevision(command: CreateQuoteRevisionCommand): Promise<QuoteRevisionOperationResult> {
    return this.repository.withTransaction(async (transaction) => {
      const operationName = "create_quote_revision";
      const claim = await transaction.claimIdempotency({
        idempotencyKey: command.idempotencyKey,
        operationName,
        requestHash: buildCommandRequestHash(command),
        expiresAt: new Date(Date.parse(command.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (claim.kind === "replay") {
        return claim.responseBodySnapshot as QuoteRevisionOperationResult;
      }

      const predecessor = await transaction.findById(command.quoteId);

      if (!predecessor) {
        throw new ApplicationError(APPLICATION_ERROR_CODES.quoteNotFound, "Quote not found", {
          quoteId: command.quoteId
        });
      }

      let revisionResult;

      try {
        revisionResult = predecessor.createRevision({
          quoteId: crypto.randomUUID(),
          quoteNumber: await transaction.allocateNextQuoteNumber(),
          actor: command.actor,
          source: command.source,
          createdAt: command.createdAt,
          ...(command.validUntil !== undefined ? { validUntil: command.validUntil } : {})
        });
      } catch (error) {
        normalizeApplicationError(error);
      }

      const persistedRevision = regenerateLineIds(revisionResult.revision);

      const result = {
        quote: persistedRevision.toSnapshot(),
        predecessorLink: revisionResult.predecessorLink
      } satisfies QuoteRevisionOperationResult;

      await transaction.persistRevisionAtomically({
        revision: persistedRevision,
        predecessorLink: revisionResult.predecessorLink,
        predecessorExpectedVersion: command.expectedVersion,
        auditEvents: [
          buildAuditEvent({
            quoteId: result.quote.quoteId,
            quoteNumber: result.quote.quoteNumber,
            action: "revision_created",
            fromStatus: null,
            toStatus: result.quote.status,
            actorType: command.actor.type,
            actorId: command.actor.id,
            sourceSystem: command.source.system,
            correlationId: command.source.correlationId ?? null,
            idempotencyKey: command.idempotencyKey,
            eventAt: command.createdAt,
            payloadSnapshot: {
              predecessorQuoteId: predecessor.quoteId,
              lineCount: result.quote.items.length,
              total: result.quote.pricing.total
            }
          }),
          buildAuditEvent({
            quoteId: predecessor.quoteId,
            quoteNumber: predecessor.quoteNumber,
            action: "revision_created",
            fromStatus: predecessor.status,
            toStatus: predecessor.status,
            actorType: command.actor.type,
            actorId: command.actor.id,
            sourceSystem: command.source.system,
            correlationId: command.source.correlationId ?? null,
            idempotencyKey: command.idempotencyKey,
            eventAt: command.createdAt,
            payloadSnapshot: {
              successorQuoteId: result.quote.quoteId
            }
          })
        ],
        idempotencyCompletion: buildRevisionIdempotencyCompletion(
          operationName,
          command.idempotencyKey,
          result,
          "quote_revision_created",
          command.createdAt
        )
      });

      return result;
    });
  }

  async findById(quoteId: string): Promise<QuoteSnapshot | null> {
    return (await this.repository.findById(quoteId))?.toSnapshot() ?? null;
  }

  async findByQuoteNumber(quoteNumber: string): Promise<QuoteSnapshot | null> {
    return (await this.repository.findByQuoteNumber(quoteNumber))?.toSnapshot() ?? null;
  }

  async listQuotes(filters: QuoteListFilters): Promise<QuoteListResult> {
    return this.repository.listQuotes(filters);
  }

  async listAuditEvents(input: QuoteAuditListInput): Promise<QuoteAuditListResult> {
    return this.repository.listAuditEvents(input);
  }

  async issueQuoteWithDocuments(
    command: Omit<IssueQuoteCommand, "issuedDocument">,
    documentIssuancePort: DocumentIssuancePort
  ): Promise<QuoteOperationResult> {
    const currentQuote = await this.findById(command.quoteId);

    if (!currentQuote) {
      throw new ApplicationError(APPLICATION_ERROR_CODES.quoteNotFound, "Quote not found", {
        quoteId: command.quoteId
      });
    }

    const issuedDocument = await documentIssuancePort.issueForQuote({
      quote: currentQuote,
      issuedAt: command.issuedAt
    });

    return this.issueQuote({
      ...command,
      issuedDocument
    });
  }

  private async transitionQuote(input: {
    readonly command:
      | AcceptQuoteCommand
      | MarkQuotePaidCommand
      | CancelQuoteCommand
      | ExpireQuoteCommand;
    readonly operationName: string;
    readonly responseCode: string;
    readonly timestamp: string;
    readonly mutate: (quote: Quote) => Quote;
    readonly action: "accepted" | "paid" | "cancelled" | "expired";
    readonly payloadSnapshot: Record<string, unknown>;
  }): Promise<QuoteOperationResult> {
    return this.mutateExistingQuote({
      command: input.command,
      operationName: input.operationName,
      responseCode: input.responseCode,
      loadTimestamp: input.timestamp,
      mutate: input.mutate,
      buildAudit: (quoteBefore, quoteAfter) =>
        buildAuditEvent({
          quoteId: quoteAfter.quoteId,
          quoteNumber: quoteAfter.quoteNumber,
          action: input.action,
          fromStatus: quoteBefore.status,
          toStatus: quoteAfter.status,
          actorType: input.command.actor.type,
          actorId: input.command.actor.id,
          sourceSystem: input.command.source.system,
          correlationId: input.command.source.correlationId ?? null,
          idempotencyKey: input.command.idempotencyKey,
          eventAt: input.timestamp,
          payloadSnapshot: input.payloadSnapshot
        })
    });
  }

  private async mutateExistingQuote<TCommand extends CommandMetadata & {
    readonly quoteId: string;
    readonly expectedVersion: number;
  }>(input: {
    readonly command: TCommand;
    readonly operationName: string;
    readonly responseCode: string;
    readonly loadTimestamp: string;
    readonly mutate: (quote: Quote) => Quote;
    readonly buildAudit: (quoteBefore: Quote, quoteAfter: Quote) => QuoteAuditEventRecord;
  }): Promise<QuoteOperationResult> {
    return this.repository.withTransaction(async (transaction) => {
      const claim = await transaction.claimIdempotency({
        idempotencyKey: input.command.idempotencyKey,
        operationName: input.operationName,
        requestHash: buildCommandRequestHash(input.command),
        expiresAt: new Date(Date.parse(input.loadTimestamp) + 30 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (claim.kind === "replay") {
        return claim.responseBodySnapshot as QuoteOperationResult;
      }

      const current = await transaction.findById(input.command.quoteId);

      if (!current) {
        throw new ApplicationError(APPLICATION_ERROR_CODES.quoteNotFound, "Quote not found", {
          quoteId: input.command.quoteId
        });
      }

      let updated: Quote;

      try {
        updated = input.mutate(current);
      } catch (error) {
        normalizeApplicationError(error);
      }
      const result = {
        quote: updated.toSnapshot()
      } satisfies QuoteOperationResult;

      await transaction.persistExistingQuote({
        quote: updated,
        expectedVersion: input.command.expectedVersion,
        auditEvents: [input.buildAudit(current, updated)],
        idempotencyCompletion: buildIdempotencyCompletion(
          input.operationName,
          input.command.idempotencyKey,
          result.quote,
          input.responseCode,
          input.loadTimestamp
        )
      });

      return result;
    });
  }
}
