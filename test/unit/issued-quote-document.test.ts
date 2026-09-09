import { describe, expect, it } from "vitest";

import type { QuoteSnapshot } from "../../src/domain";
import {
  buildCanonicalIssuedQuoteSnapshot,
  buildIssuedQuoteDocumentViewModel,
  createIssuedQuoteContentHash
} from "../../src/application/quote/documents/issued-quote-document";

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

describe("issued quote documents", () => {
  it("builds a deterministic canonical snapshot and content hash", () => {
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
    expect(createIssuedQuoteContentHash(snapshotA)).toBe(createIssuedQuoteContentHash(snapshotB));
  });

  it("changes the content hash when commercial data changes", () => {
    const originalLine = buildQuoteSnapshot().items[0]!;
    const original = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot(),
      "2026-08-10T18:30:00.000Z"
    );
    const changed = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot({
        items: [
          {
            lineId: originalLine.lineId,
            type: originalLine.type,
            externalSource: originalLine.externalSource,
            externalItemId: originalLine.externalItemId,
            externalVariantId: originalLine.externalVariantId,
            sku: originalLine.sku,
            description: originalLine.description,
            quantity: "3.000000",
            unitPrice: originalLine.unitPrice,
            taxIncluded: originalLine.taxIncluded,
            taxRate: originalLine.taxRate,
            lineSubtotal: "12587",
            lineTax: "2391",
            lineTotal: "14978"
          }
        ],
        pricing: {
          subtotal: "12587",
          taxAmount: "2391",
          total: "14978"
        }
      }),
      "2026-08-10T18:30:00.000Z"
    );

    expect(createIssuedQuoteContentHash(changed)).not.toBe(createIssuedQuoteContentHash(original));
  });

  it("builds a document view model with CLP formatting and normalized quantities", () => {
    const viewModel = buildIssuedQuoteDocumentViewModel({
      snapshot: buildCanonicalIssuedQuoteSnapshot(
        buildQuoteSnapshot(),
        "2026-08-10T18:30:00.000Z"
      ),
      renderVersion: "quote-v1",
      companyName: "Pesas Chile SPA"
    });

    expect(viewModel.issuedAtDisplay).toBe("10/08/2026");
    expect(viewModel.validUntilDisplay).toBe("20/08/2026");
    expect(viewModel.items[0]).toMatchObject({
      quantityDisplay: "2",
      unitPriceDisplay: "$4.990",
      lineSubtotalDisplay: "$8.387",
      lineTaxDisplay: "$1.593",
      lineTotalDisplay: "$9.980"
    });
    expect(viewModel.pricing).toEqual({
      pricingNote: "Precios incluyen IVA",
      subtotalDisplay: "$8.387",
      taxAmountDisplay: "$1.593",
      totalDisplay: "$9.980"
    });
  });

  // SALES-AGENT-R1-T1.1, task section 5: PDF/email must never expose
  // externalSource/externalItemId/externalVariantId - only description/sku
  // (sku already a preexisting visual decision) reach the view model.
  it("never exposes externalSource/externalItemId/externalVariantId in the document view model", () => {
    const viewModel = buildIssuedQuoteDocumentViewModel({
      snapshot: buildCanonicalIssuedQuoteSnapshot(buildQuoteSnapshot(), "2026-08-10T18:30:00.000Z"),
      renderVersion: "quote-v1",
      companyName: "Pesas Chile SPA"
    });

    expect(viewModel.items[0]).not.toHaveProperty("externalSource");
    expect(viewModel.items[0]).not.toHaveProperty("externalItemId");
    expect(viewModel.items[0]).not.toHaveProperty("externalVariantId");
    expect(viewModel.items[0]).toHaveProperty("sku", "SKU-1");
  });

  // SALES-AGENT-R1-T1.1, task section 13.7: the content hash (the same
  // mechanism idempotency request hashing already reuses via
  // createCanonicalRequestHash) must distinguish two lines that differ ONLY
  // by externalVariantId - never collapse two different catalog variants
  // into the same commercial identity.
  it("the content hash distinguishes two otherwise-identical lines that differ only by externalVariantId", () => {
    const variant31 = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot({
        items: [
          {
            lineId: "97686fc1-543f-4d83-b902-c0b1023e2bd8",
            type: "product",
            externalSource: "catalog_service",
            externalItemId: "545",
            externalVariantId: "31",
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
        ]
      }),
      "2026-08-10T18:30:00.000Z"
    );
    const variant32 = buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot({
        items: [
          {
            lineId: "97686fc1-543f-4d83-b902-c0b1023e2bd8",
            type: "product",
            externalSource: "catalog_service",
            externalItemId: "545",
            externalVariantId: "32",
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
        ]
      }),
      "2026-08-10T18:30:00.000Z"
    );

    expect(createIssuedQuoteContentHash(variant31)).not.toBe(createIssuedQuoteContentHash(variant32));
  });

  // SALES-AGENT-R1-T1.1, task section 3/13.9: a historical/legacy line with
  // no catalog identity at all (all three external fields null) must still
  // build a valid canonical snapshot and content hash - additive fields are
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
    expect(() => createIssuedQuoteContentHash(snapshot)).not.toThrow();
  });
});
