import type { QuoteSnapshot } from "../../../domain";
import { createCanonicalRequestHash } from "../canonical-json";

export interface CanonicalIssuedQuoteLineSnapshot {
  readonly lineId: string;
  readonly type: QuoteSnapshot["items"][number]["type"];
  readonly externalItemId: string | null;
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

export interface IssuedQuoteDocumentViewModel {
  readonly renderVersion: string;
  readonly companyName: string;
  readonly quoteNumber: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly issuedAtDisplay: string;
  readonly validUntil: string;
  readonly validUntilDisplay: string;
  readonly customer: {
    readonly name: string;
    readonly businessName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly address: string | null;
    readonly district: string | null;
    readonly region: string | null;
  };
  readonly items: Array<{
    readonly typeLabel: string;
    readonly description: string;
    readonly sku: string | null;
    readonly quantityDisplay: string;
    readonly unitPriceDisplay: string;
    readonly lineSubtotalDisplay: string;
    readonly lineTaxDisplay: string;
    readonly lineTotalDisplay: string;
  }>;
  readonly pricing: {
    readonly subtotalDisplay: string;
    readonly taxAmountDisplay: string;
    readonly totalDisplay: string;
  };
}

function formatClpMoney(value: string): string {
  const normalized = value.trim();
  const isNegative = normalized.startsWith("-");
  const digits = isNegative ? normalized.slice(1) : normalized;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${isNegative ? "-" : ""}$${grouped}`;
}

function formatQuantityDisplay(value: string): string {
  if (!value.includes(".")) {
    return value;
  }

  return value.replace(/\.?0+$/, "");
}

function formatUtcDateDisplay(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${day}/${month}/${year}`;
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
      externalItemId: item.externalItemId,
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

export function createIssuedQuoteContentHash(snapshot: CanonicalIssuedQuoteSnapshot): string {
  return createCanonicalRequestHash({
    documentType: "issued_quote",
    snapshot
  });
}

export function buildIssuedQuoteDocumentViewModel(input: {
  readonly snapshot: CanonicalIssuedQuoteSnapshot;
  readonly renderVersion: string;
  readonly companyName: string;
}): IssuedQuoteDocumentViewModel {
  return {
    renderVersion: input.renderVersion,
    companyName: input.companyName,
    quoteNumber: input.snapshot.quoteNumber,
    currency: input.snapshot.currency,
    issuedAt: input.snapshot.issuedAt,
    issuedAtDisplay: formatUtcDateDisplay(input.snapshot.issuedAt),
    validUntil: input.snapshot.validUntil,
    validUntilDisplay: formatUtcDateDisplay(input.snapshot.validUntil),
    customer: {
      name: input.snapshot.customerSnapshot.name,
      businessName: input.snapshot.customerSnapshot.businessName,
      email: input.snapshot.customerSnapshot.email,
      phone: input.snapshot.customerSnapshot.phone,
      address: input.snapshot.customerSnapshot.address,
      district: input.snapshot.customerSnapshot.district,
      region: input.snapshot.customerSnapshot.region
    },
    items: input.snapshot.items.map((item) => ({
      typeLabel: item.type === "product" ? "Producto" : "Servicio",
      description: item.description,
      sku: item.sku,
      quantityDisplay: formatQuantityDisplay(item.quantity),
      unitPriceDisplay: formatClpMoney(item.unitPrice),
      lineSubtotalDisplay: formatClpMoney(item.lineSubtotal),
      lineTaxDisplay: formatClpMoney(item.lineTax),
      lineTotalDisplay: formatClpMoney(item.lineTotal)
    })),
    pricing: {
      subtotalDisplay: formatClpMoney(input.snapshot.pricing.subtotal),
      taxAmountDisplay: formatClpMoney(input.snapshot.pricing.taxAmount),
      totalDisplay: formatClpMoney(input.snapshot.pricing.total)
    }
  };
}
