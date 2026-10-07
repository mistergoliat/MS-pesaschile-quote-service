import type { QuoteSnapshot } from "../../../domain";

/*
 * LEGACY (R1.6 email only). The V1 issued-quote snapshot is still the input of
 * the email view model and the email preview/smoke scripts until the R1.6 V2
 * email refactor. It is NOT an input of the V2 formal PDF: that path is
 * IssuedSnapshot → IssuedQuoteDocumentModelV2 → PdfRendererPort
 * (application/quote-v2/document). The V1 PDF view model, the V1 content hash
 * and the printable HTML artifact were removed in R1.5B2.
 */

export interface CanonicalIssuedQuoteLineSnapshot {
  readonly lineId: string;
  readonly type: QuoteSnapshot["items"][number]["type"];
  /**
   * SALES-AGENT-R1-T1.1: provenance identity, never surfaced by the email
   * view model.
   */
  readonly externalSource: string | null;
  readonly externalItemId: string | null;
  readonly externalVariantId: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxIncluded: boolean;
  readonly taxRate: string;
  readonly lineSubtotal: string;
  readonly lineTax: string;
  readonly lineTotal: string;
}

export interface CanonicalIssuedQuoteSnapshot {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly opportunityId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly currency: QuoteSnapshot["currency"];
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly customerSnapshot: QuoteSnapshot["customerSnapshot"];
  readonly items: readonly CanonicalIssuedQuoteLineSnapshot[];
  readonly pricing: QuoteSnapshot["pricing"];
}

export function buildCanonicalIssuedQuoteSnapshot(
  quote: QuoteSnapshot,
  issuedAt: string
): CanonicalIssuedQuoteSnapshot {
  return {
    quoteId: quote.quoteId,
    quoteNumber: quote.quoteNumber,
    opportunityId: quote.opportunityId,
    customerId: quote.customerId,
    conversationId: quote.conversationId,
    currency: quote.currency,
    issuedAt,
    validUntil: quote.validUntil,
    customerSnapshot: quote.customerSnapshot,
    items: quote.items.map((item) => ({
      lineId: item.lineId,
      type: item.type,
      externalSource: item.externalSource,
      externalItemId: item.externalItemId,
      externalVariantId: item.externalVariantId,
      sku: item.sku,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxIncluded: item.taxIncluded,
      taxRate: item.taxRate,
      lineSubtotal: item.lineSubtotal,
      lineTax: item.lineTax,
      lineTotal: item.lineTotal
    })),
    pricing: quote.pricing
  };
}
