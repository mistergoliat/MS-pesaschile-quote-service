import type { CanonicalIssuedQuoteSnapshot } from "../../application/quote/documents/issued-quote-document";
import {
  formatClpMoney,
  formatQuantityDisplay,
  formatUtcShortSpanishDateDisplay
} from "../../application/quote/documents/document-formatting";
import type { BrandTheme, SenderSignature } from "../branding/brand-theme";
import { QUOTE_EMAIL_VALIDITY_POLICY_DAYS } from "../branding/pesaschile-brand-v1";

export interface QuoteEmailViewModel {
  readonly brand: BrandTheme;
  readonly brandVersion: string;
  readonly emailTemplateVersion: string;
  readonly quote: {
    readonly quoteNumber: string;
    readonly issuedAt: string;
    readonly issuedAtFormatted: string;
    readonly validUntil: string;
    readonly validUntilFormatted: string;
    readonly currency: string;
  };
  readonly customer: {
    readonly name: string;
    readonly businessName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
  readonly items: Array<{
    readonly type: CanonicalIssuedQuoteSnapshot["items"][number]["type"];
    readonly typeLabel: string;
    readonly description: string;
    readonly sku: string | null;
    readonly quantity: string;
    readonly unitPriceFormatted: string;
    readonly lineTotalFormatted: string;
  }>;
  readonly pricing: {
    readonly subtotalFormatted: string;
    readonly taxFormatted: string;
    readonly totalFormatted: string;
  };
  readonly validity: {
    readonly days: typeof QUOTE_EMAIL_VALIDITY_POLICY_DAYS;
    readonly validUntilFormatted: string;
    readonly policyText: string;
  };
  readonly senderSignature: {
    readonly name: string;
    readonly role: string;
    readonly website: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly address: string | null;
    readonly socialLinks: SenderSignature["socialLinks"] | null;
  };
}

export function buildQuoteEmailViewModel(input: {
  readonly snapshot: CanonicalIssuedQuoteSnapshot;
  readonly brand: BrandTheme;
  readonly emailTemplateVersion: string;
  readonly senderSignature: SenderSignature;
}): QuoteEmailViewModel {
  const validUntilFormatted = formatUtcShortSpanishDateDisplay(input.snapshot.validUntil);

  return {
    brand: input.brand,
    brandVersion: input.brand.version,
    emailTemplateVersion: input.emailTemplateVersion,
    quote: {
      quoteNumber: input.snapshot.quoteNumber,
      issuedAt: input.snapshot.issuedAt,
      issuedAtFormatted: formatUtcShortSpanishDateDisplay(input.snapshot.issuedAt),
      validUntil: input.snapshot.validUntil,
      validUntilFormatted,
      currency: input.snapshot.currency
    },
    customer: {
      name: input.snapshot.customerSnapshot.name,
      businessName: input.snapshot.customerSnapshot.businessName,
      email: input.snapshot.customerSnapshot.email,
      phone: input.snapshot.customerSnapshot.phone
    },
    items: input.snapshot.items.map((item) => ({
      type: item.type,
      typeLabel: item.type === "product" ? "Producto" : "Servicio",
      description: item.description,
      sku: item.sku,
      quantity: formatQuantityDisplay(item.quantity),
      unitPriceFormatted: formatClpMoney(item.unitPrice),
      lineTotalFormatted: formatClpMoney(item.lineTotal)
    })),
    pricing: {
      subtotalFormatted: formatClpMoney(input.snapshot.pricing.subtotal),
      taxFormatted: formatClpMoney(input.snapshot.pricing.taxAmount),
      totalFormatted: formatClpMoney(input.snapshot.pricing.total)
    },
    validity: {
      days: QUOTE_EMAIL_VALIDITY_POLICY_DAYS,
      validUntilFormatted,
      policyText: `Esta cotización y sus precios son válidos por ${QUOTE_EMAIL_VALIDITY_POLICY_DAYS} días desde su emisión.`
    },
    senderSignature: {
      name: input.senderSignature.name,
      role: input.senderSignature.role,
      website: input.senderSignature.website ?? null,
      email: input.senderSignature.email ?? null,
      phone: input.senderSignature.phone ?? null,
      address: input.senderSignature.address ?? null,
      socialLinks: input.senderSignature.socialLinks ?? null
    }
  };
}
