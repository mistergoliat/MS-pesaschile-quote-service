import { describe, expect, it } from "vitest";

import { buildCanonicalIssuedQuoteSnapshot } from "../../src/application/quote/documents/issued-quote-document";
import type { QuoteSnapshot } from "../../src/domain";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "../../src/infrastructure/branding/pesaschile-brand-v1";
import { buildQuoteEmailViewModel } from "../../src/infrastructure/documents/quote-email-view-model";

function buildQuoteSnapshot(): QuoteSnapshot {
  return {
    quoteId: "quote-email-vm-1",
    quoteNumber: "PC-000777",
    opportunityId: "opp-777",
    customerId: "customer-777",
    conversationId: "conversation-777",
    actor: {
      type: "sales_agent",
      id: "agent-1"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-777"
    },
    status: "draft",
    currency: "CLP",
    customerSnapshot: {
      name: "Cliente Demo",
      businessName: "Pesas Chile",
      email: "client@example.com",
      phone: "12345678",
      address: "Street 1",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        lineId: "line-1",
        type: "service",
        externalItemId: null,
        sku: "SKU-9",
        description: "Servicio Premium",
        quantity: "1.000000",
        unitPrice: "37566",
        taxIncluded: true,
        taxRate: "0.19",
        lineSubtotal: "31568",
        lineTax: "5998",
        lineTotal: "37566"
      }
    ],
    pricing: {
      subtotal: "31568",
      taxAmount: "5998",
      total: "37566"
    },
    validUntil: "2026-08-17T00:00:00.000Z",
    version: 1,
    revisionRootId: "quote-email-vm-1",
    previousRevisionId: null,
    supersedesQuoteId: null,
    supersededByQuoteId: null,
    issuedDocument: null,
    timestamps: {
      createdAt: "2026-08-10T18:25:00.000Z",
      updatedAt: "2026-08-10T18:25:00.000Z",
      issuedAt: null,
      acceptedAt: null,
      paidAt: null,
      cancelledAt: null,
      expiredAt: null
    }
  };
}

describe("quote email view model", () => {
  it("maps formatted values and configurable sender signature", () => {
    const viewModel = buildQuoteEmailViewModel({
      snapshot: buildCanonicalIssuedQuoteSnapshot(
        buildQuoteSnapshot(),
        "2026-08-12T18:30:00.000Z"
      ),
      brand: createPesasChileBrandV1(),
      emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
      senderSignature: {
        ...createDefaultPesasChileSenderSignatureV1(),
        name: "Valentina Soto",
        role: "Ejecutiva Comercial"
      }
    });

    expect(viewModel.brandVersion).toBe("pesaschile-brand-v1");
    expect(viewModel.emailTemplateVersion).toBe("quote-email-v1");
    expect(viewModel.quote.issuedAtFormatted).toBe("12 AGO 2026");
    expect(viewModel.quote.validUntilFormatted).toBe("17 AGO 2026");
    expect(viewModel.items[0]).toEqual({
      type: "service",
      typeLabel: "Servicio",
      description: "Servicio Premium",
      sku: "SKU-9",
      quantity: "1",
      unitPriceFormatted: "$37.566",
      lineTotalFormatted: "$37.566"
    });
    expect(viewModel.pricing).toEqual({
      subtotalFormatted: "$31.568",
      taxFormatted: "$5.998",
      totalFormatted: "$37.566"
    });
    expect(viewModel.validity).toEqual({
      days: 5,
      validUntilFormatted: "17 AGO 2026",
      policyText: "Esta cotización y sus precios son válidos por 5 días desde su emisión."
    });
    expect(viewModel.senderSignature.name).toBe("Valentina Soto");
    expect(viewModel.senderSignature.role).toBe("Ejecutiva Comercial");
  });
});
