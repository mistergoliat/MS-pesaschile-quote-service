import type {
  QuoteAuditEventSnapshot,
  QuoteAuditListResult,
  QuoteListResult
} from "../application/quote/ports/quote-repository";
import type { QuoteSnapshot } from "../domain";

export interface PublicIssuedDocumentDto {
  readonly available: boolean;
  readonly contentHash: string | null;
  readonly renderVersion: string | null;
  readonly generatedAt: string | null;
  readonly pdf: {
    readonly documentRef: string | null;
    readonly sha256: string | null;
  };
  readonly html: {
    readonly documentRef: string | null;
    readonly sha256: string | null;
  };
}

export interface PublicQuoteDto {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly opportunityId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly actor: QuoteSnapshot["actor"];
  readonly source: QuoteSnapshot["source"];
  readonly status: QuoteSnapshot["status"];
  readonly currency: QuoteSnapshot["currency"];
  readonly customerSnapshot: QuoteSnapshot["customerSnapshot"];
  readonly items: QuoteSnapshot["items"];
  readonly pricing: QuoteSnapshot["pricing"];
  readonly validUntil: string;
  readonly version: number;
  readonly revision: {
    readonly rootId: string;
    readonly previousRevisionId: string | null;
    readonly supersedesQuoteId: string | null;
    readonly supersededByQuoteId: string | null;
  };
  readonly issuedDocument: PublicIssuedDocumentDto;
  readonly timestamps: QuoteSnapshot["timestamps"];
}

export interface PublicQuoteListDto {
  readonly items: readonly PublicQuoteDto[];
  readonly pagination: QuoteListResult["pagination"];
}

export interface PublicQuoteAuditEventDto {
  readonly auditEventId: string;
  readonly action: QuoteAuditEventSnapshot["action"];
  readonly fromStatus: QuoteAuditEventSnapshot["fromStatus"];
  readonly toStatus: QuoteAuditEventSnapshot["toStatus"];
  readonly actor: {
    readonly type: QuoteAuditEventSnapshot["actorType"];
    readonly id: string;
  };
  readonly source: {
    readonly system: QuoteAuditEventSnapshot["sourceSystem"];
    readonly correlationId: string | null;
  };
  readonly eventAt: string;
  readonly payload: QuoteAuditEventSnapshot["payloadSnapshot"];
}

export interface PublicQuoteAuditListDto {
  readonly items: readonly PublicQuoteAuditEventDto[];
  readonly pagination: QuoteAuditListResult["pagination"];
}

export function toPublicIssuedDocument(
  issuedDocument: QuoteSnapshot["issuedDocument"]
): PublicIssuedDocumentDto {
  if (!issuedDocument) {
    return {
      available: false,
      contentHash: null,
      renderVersion: null,
      generatedAt: null,
      pdf: {
        documentRef: null,
        sha256: null
      },
      html: {
        documentRef: null,
        sha256: null
      }
    };
  }

  return {
    available: true,
    contentHash: issuedDocument.contentHash,
    renderVersion: issuedDocument.renderVersion,
    generatedAt: issuedDocument.generatedAt,
    pdf: {
      documentRef: null,
      sha256: issuedDocument.pdfSha256
    },
    html: {
      documentRef: null,
      sha256: issuedDocument.htmlSha256
    }
  };
}

export function toPublicQuoteDto(
  snapshot: QuoteSnapshot,
  issuedDocument = toPublicIssuedDocument(snapshot.issuedDocument)
): PublicQuoteDto {
  return {
    quoteId: snapshot.quoteId,
    quoteNumber: snapshot.quoteNumber,
    opportunityId: snapshot.opportunityId,
    customerId: snapshot.customerId,
    conversationId: snapshot.conversationId,
    actor: snapshot.actor,
    source: snapshot.source,
    status: snapshot.status,
    currency: snapshot.currency,
    customerSnapshot: snapshot.customerSnapshot,
    items: snapshot.items,
    pricing: snapshot.pricing,
    validUntil: snapshot.validUntil,
    version: snapshot.version,
    revision: {
      rootId: snapshot.revisionRootId,
      previousRevisionId: snapshot.previousRevisionId,
      supersedesQuoteId: snapshot.supersedesQuoteId,
      supersededByQuoteId: snapshot.supersededByQuoteId
    },
    issuedDocument,
    timestamps: snapshot.timestamps
  };
}

export function toPublicQuoteListDto(
  result: QuoteListResult,
  mapIssuedDocument?: (quote: QuoteSnapshot) => PublicIssuedDocumentDto
): PublicQuoteListDto {
  return {
    items: result.items.map((quote) => toPublicQuoteDto(quote, mapIssuedDocument?.(quote))),
    pagination: result.pagination
  };
}

export function toPublicQuoteAuditListDto(result: QuoteAuditListResult): PublicQuoteAuditListDto {
  return {
    items: result.items.map((event) => ({
      auditEventId: event.auditEventId,
      action: event.action,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actor: {
        type: event.actorType,
        id: event.actorId
      },
      source: {
        system: event.sourceSystem,
        correlationId: event.correlationId
      },
      eventAt: event.eventAt,
      payload: event.payloadSnapshot
    })),
    pagination: result.pagination
  };
}

