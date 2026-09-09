import { describe, expect, it } from "vitest";

import { DOMAIN_ERROR_CODES, Quote } from "../../src/domain";
import { expectDomainError } from "./domain-test-helpers";

describe("Quote rehydration", () => {
  it("reconstructs a durable issued quote without replaying transitions", () => {
    const snapshot = {
      quoteId: "48d6a2b4-8051-48f8-8e2c-2857c4fd1ef1",
      quoteNumber: "PC-000123",
      opportunityId: "opp-1",
      customerId: "customer-1",
      conversationId: "conversation-1",
      actor: {
        type: "sales_agent" as const,
        id: "agent-1"
      },
      source: {
        system: "crm_customer_360" as const,
        correlationId: "corr-1"
      },
      status: "issued" as const,
      currency: "CLP" as const,
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
          lineId: "6d22cbc6-54ad-4956-b8b6-cd2743bf9e01",
          type: "product" as const,
          externalSource: null,
          externalItemId: null,
          externalVariantId: null,
          sku: null,
          description: "Product",
          quantity: "2",
          unitPrice: "1000",
          taxIncluded: false,
          taxRate: "0.19",
          lineSubtotal: "2000",
          lineTax: "380",
          lineTotal: "2380"
        }
      ],
      pricing: {
        subtotal: "2000",
        taxAmount: "380",
        total: "2380"
      },
      validUntil: "2026-08-20T00:00:00.000Z",
      version: 2,
      revisionRootId: "48d6a2b4-8051-48f8-8e2c-2857c4fd1ef1",
      previousRevisionId: null,
      supersedesQuoteId: null,
      supersededByQuoteId: null,
      issuedDocument: {
        contentHash: "content-hash-v1",
        renderVersion: "v1",
        pdfStorageKey: "quotes/q-1.pdf",
        pdfSha256: "a".repeat(64),
        htmlStorageKey: "quotes/q-1.html",
        htmlSha256: "b".repeat(64),
        generatedAt: "2026-08-10T01:00:00.000Z"
      },
      timestamps: {
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T02:00:00.000Z",
        issuedAt: "2026-08-10T02:00:00.000Z",
        acceptedAt: null,
        paidAt: null,
        cancelledAt: null,
        expiredAt: null
      }
    };

    const quote = Quote.rehydrate(snapshot);

    expect(quote.toSnapshot()).toEqual(snapshot);
  });

  it("rejects persisted pricing that does not reconcile with lines", () => {
    expectDomainError(
      () =>
        Quote.rehydrate({
          quoteId: "48d6a2b4-8051-48f8-8e2c-2857c4fd1ef1",
          quoteNumber: "PC-000123",
          opportunityId: "opp-1",
          customerId: null,
          conversationId: null,
          actor: {
            type: "sales_agent",
            id: "agent-1"
          },
          source: {
            system: "crm_customer_360",
            correlationId: null
          },
          status: "draft",
          currency: "CLP",
          customerSnapshot: {
            name: "Jane Doe",
            businessName: null,
            email: null,
            phone: null,
            address: null,
            district: null,
            region: null
          },
          items: [
            {
              lineId: "6d22cbc6-54ad-4956-b8b6-cd2743bf9e01",
              type: "product",
              externalSource: null,
              externalItemId: null,
              externalVariantId: null,
              sku: null,
              description: "Product",
              quantity: "1",
              unitPrice: "1000",
              taxIncluded: false,
              taxRate: "0.19",
              lineSubtotal: "1000",
              lineTax: "190",
              lineTotal: "1190"
            }
          ],
          pricing: {
            subtotal: "999",
            taxAmount: "190",
            total: "1189"
          },
          validUntil: "2026-08-20T00:00:00.000Z",
          version: 1,
          revisionRootId: "48d6a2b4-8051-48f8-8e2c-2857c4fd1ef1",
          previousRevisionId: null,
          supersedesQuoteId: null,
          supersededByQuoteId: null,
          issuedDocument: null,
          timestamps: {
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            issuedAt: null,
            acceptedAt: null,
            paidAt: null,
            cancelledAt: null,
            expiredAt: null
          }
        }),
      DOMAIN_ERROR_CODES.invalidQuoteReference
    );
  });
});

