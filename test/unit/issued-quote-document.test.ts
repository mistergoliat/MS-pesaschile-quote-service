import { describe, expect, it } from "vitest";

import type { QuoteSnapshot } from "../../src/domain";
import { buildCanonicalIssuedQuoteSnapshot } from "../../src/application/quote/documents/issued-quote-document";

function buildQuoteSnapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    quoteId: "f57429c4-168f-43c7-a46a-cbaf4df5f998",
    quoteNumber: "PC-000123",
    opportunityId: "opp-123",
    customerId: "customer-123",
    conversationId: "conversation-123",
    actor: {
      type: "sales_agent",
      id: "agent-1"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-1"
    },
    status: "draft",
    currency: "CLP",
    customerSnapshot: {
      name: "Jane Doe",
      businessName: "Pesas Chile",
      email: "jane@example.com",
      phone: "12345678",
      address: "Street 1",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        lineId: "97686fc1-543f-4d83-b902-c0b1023e2bd8",
        type: "product",
        externalSource: "catalog_service",
        externalItemId: "sku-1",
        externalVariantId: null,
        sku: "SKU-1",
        description: "Mancuerna",
        quantity: "2.000000",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19",
        lineSubtotal: "8387",
        lineTax: "1593",
        lineTotal: "9980"
      }
    ],
    pricing: {
      subtotal: "8387",
      taxAmount: "1593",
      total: "9980"
    },
    validUntil: "2026-08-20T00:00:00.000Z",
    version: 1,
    revisionRootId: "f57429c4-168f-43c7-a46a-cbaf4df5f998",
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
    },
    ...overrides
  };
}

// LEGACY (R1.6 email input). The V1 PDF view model and V1 content hash were
// removed in R1.5B2; the V2 formal PDF is covered by issued-quote-document-model
// and native-pdf-renderer tests.
describe("legacy canonical issued quote snapshot (email input)", () => {
  it("builds a canonical snapshot independent of actor, source, version and timestamps", () => {
    const baseQuote = buildQuoteSnapshot();
    const metadataChangedQuote = buildQuoteSnapshot({
      actor: {
        type: "operator",
        id: "operator-9"
      },
      source: {
        system: "manual",
        correlationId: "corr-2"
      },
      version: 7,
      timestamps: {
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-10T19:00:00.000Z",
        issuedAt: null,
        acceptedAt: null,
        paidAt: null,
        cancelledAt: null,
        expiredAt: null
      }
    });

    const snapshotA = buildCanonicalIssuedQuoteSnapshot(baseQuote, "2026-08-10T18:30:00.000Z");
    const snapshotB = buildCanonicalIssuedQuoteSnapshot(
      metadataChangedQuote,
      "2026-08-10T18:30:00.000Z"
    );

    expect(snapshotA).toEqual(snapshotB);
  });

  it("preserves a V1 shipping line in the canonical snapshot", () => {
    const snapshot = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot({
        items: [
          {
            lineId: "shipping-line-1",
            type: "shipping",
            externalSource: null,
            externalItemId: null,
            externalVariantId: null,
            sku: null,
            description: "Despacho",
            quantity: "1.000000",
            unitPrice: "11900",
            taxIncluded: true,
            taxRate: "0.19",
            lineSubtotal: "10000",
            lineTax: "1900",
            lineTotal: "11900"
          }
        ],
        pricing: {
          subtotal: "10000",
          taxAmount: "1900",
          total: "11900"
        }
      }),
      "2026-08-10T18:30:00.000Z"
    );

    expect(snapshot.items[0]).toMatchObject({
      type: "shipping",
      unitPrice: "11900",
      lineTotal: "11900"
    });
  });

  // SALES-AGENT-R1-T1.1, task section 3/13.9: a historical/legacy line with
  // no catalog identity at all (all three external fields null) must still
  // build a valid canonical snapshot - additive fields are
  // never a universal requirement.
  it("a historical line with null externalSource/externalItemId/externalVariantId builds a valid snapshot", () => {
    const snapshot = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot({
        items: [
          {
            lineId: "97686fc1-543f-4d83-b902-c0b1023e2bd8",
            type: "service",
            externalSource: null,
            externalItemId: null,
            externalVariantId: null,
            sku: null,
            description: "Servicio de instalacion (linea historica, previa a T1.1)",
            quantity: "1.000000",
            unitPrice: "4990",
            taxIncluded: true,
            taxRate: "0.19",
            lineSubtotal: "4193",
            lineTax: "797",
            lineTotal: "4990"
          }
        ]
      }),
      "2026-08-10T18:30:00.000Z"
    );

    expect(snapshot.items[0]).toMatchObject({
      externalSource: null,
      externalItemId: null,
      externalVariantId: null
    });
  });
});
