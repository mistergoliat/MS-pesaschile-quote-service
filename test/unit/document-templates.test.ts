import { describe, expect, it } from "vitest";

import {
  buildCanonicalIssuedQuoteSnapshot,
  buildIssuedQuoteDocumentViewModel
} from "../../src/application/quote/documents/issued-quote-document";
import type { QuoteSnapshot } from "../../src/domain";
import {
  renderQuoteEmailHtml,
  renderQuotePrintableHtml
} from "../../src/infrastructure/documents/document-templates";

function buildQuoteSnapshot(): QuoteSnapshot {
  return {
    quoteId: "929a87f5-46f9-4e3e-a9fa-b4bbbe4b8ef3",
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
      name: "<script>alert('xss')</script>",
      businessName: "Pesas <b>Chile</b>",
      email: "client@example.com",
      phone: "12345678",
      address: "Street < 1 >",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        lineId: "daab167e-ca72-43bc-9677-5ecfbb7d19e6",
        type: "service",
        externalItemId: null,
        sku: "SKU-9",
        description: `Servicio "Premium" & <b>instalacion</b>`,
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
    validUntil: "2026-08-31T00:00:00.000Z",
    version: 1,
    revisionRootId: "929a87f5-46f9-4e3e-a9fa-b4bbbe4b8ef3",
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

function buildViewModel() {
  return buildIssuedQuoteDocumentViewModel({
    snapshot: buildCanonicalIssuedQuoteSnapshot(
      buildQuoteSnapshot(),
      "2026-08-10T18:30:00.000Z"
    ),
    renderVersion: "quote-v1",
    companyName: "Pesas Chile SPA"
  });
}

describe("document templates", () => {
  it("renders email HTML with canonical totals and escaped customer content", () => {
    const html = renderQuoteEmailHtml(buildViewModel());

    expect(html).toContain("PC-000777");
    expect(html).toContain("Pesas Chile SPA");
    expect(html).toContain("$37.566");
    expect(html).toContain("31/08/2026");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("Pesas &lt;b&gt;Chile&lt;/b&gt;");
    expect(html).toContain("Servicio &quot;Premium&quot; &amp; &lt;b&gt;instalacion&lt;/b&gt;");
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).not.toContain("<b>instalacion</b>");
  });

  it("renders printable HTML with the same canonical values and no raw HTML injection", () => {
    const html = renderQuotePrintableHtml(buildViewModel());

    expect(html).toContain("Cotización comercial");
    expect(html).toContain("Versión de render: quote-v1");
    expect(html).toContain("$31.568");
    expect(html).toContain("$5.998");
    expect(html).toContain("$37.566");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('xss')</script>");
  });
});
