import { describe, expect, it } from "vitest";

import {
  buildCanonicalIssuedQuoteSnapshot,
  buildIssuedQuoteDocumentViewModel
} from "../../src/application/quote/documents/issued-quote-document";
import type { QuoteSnapshot } from "../../src/domain";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "../../src/infrastructure/branding/pesaschile-brand-v1";
import {
  renderQuoteEmailHtml,
  renderQuotePrintableHtml
} from "../../src/infrastructure/documents/document-templates";
import { buildQuoteEmailViewModel } from "../../src/infrastructure/documents/quote-email-view-model";

function buildQuoteSnapshot(overrides: Partial<QuoteSnapshot["customerSnapshot"]> = {}): QuoteSnapshot {
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
      region: "RM",
      ...overrides
    },
    items: [
      {
        lineId: "daab167e-ca72-43bc-9677-5ecfbb7d19e6",
        type: "service",
        externalItemId: null,
        sku: "SKU-9",
        description: `Servicio "Premium" & <img src=x onerror=alert(1)>`,
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

function buildSnapshot(overrides: Partial<QuoteSnapshot["customerSnapshot"]> = {}) {
  return buildCanonicalIssuedQuoteSnapshot(buildQuoteSnapshot(overrides), "2026-08-12T18:30:00.000Z");
}

function buildEmailHtml(input: {
  readonly customerOverrides?: Partial<QuoteSnapshot["customerSnapshot"]>;
  readonly senderSignature?: ReturnType<typeof createDefaultPesasChileSenderSignatureV1>;
} = {}) {
  return renderQuoteEmailHtml(
    buildQuoteEmailViewModel({
      snapshot: buildSnapshot(input.customerOverrides),
      brand: createPesasChileBrandV1(),
      emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
      senderSignature: input.senderSignature ?? createDefaultPesasChileSenderSignatureV1()
    })
  );
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

describe("document templates", () => {
  it("renders email HTML with brand, pricing, validity, and contact details", () => {
    const html = buildEmailHtml();

    expect(html).toContain("PesasChile");
    expect(html).toContain("PC-000777");
    expect(html).toContain("12 AGO 2026");
    expect(html).toContain("17 AGO 2026");
    expect(html).toContain("$31.568");
    expect(html).toContain("$5.998");
    expect(html).toContain("$37.566");
    expect(html).toContain("Esta cotización y sus precios son válidos por 5 días desde su emisión.");
    expect(html).toContain("Adjuntamos el PDF formal de tu cotizacion con el detalle completo y terminos de la oferta.");
    expect(html).toContain("Bastian Castro");
    expect(html).toContain("sac@pesaschile.cl");
    expect(html).toContain("www.pesaschile.cl");
    expect(html).toContain('max-width:640px');
    expect(html).toContain("Producto / Servicio");
    expect(html).toContain('role="presentation"');
  });

  it("escapes customer, item, and sender dynamic content", () => {
    const html = buildEmailHtml({
      senderSignature: {
        ...createDefaultPesasChileSenderSignatureV1(),
        name: '<img src=x onerror=alert(1)>',
        role: '<script>alert("sender")</script>',
        website: 'javascript:alert("bad")',
        email: 'bad@example.com"><script>alert(1)</script>'
      }
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;sender&quot;)&lt;/script&gt;");
    expect(html).toContain("bad@example.com&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('href="javascript:alert');
  });

  it("omits empty optional customer and social blocks without broken labels", () => {
    const html = buildEmailHtml({
      customerOverrides: {
        businessName: null,
        email: null,
        phone: null
      },
      senderSignature: {
        name: "Bastian Castro",
        role: "Servicio al Cliente",
        address: "Maipu"
      }
    });

    expect(html).not.toContain(">Empresa<");
    expect(html).not.toContain(">Email<");
    expect(html).not.toContain(">Telefono<");
    expect(html).not.toContain("Facebook");
    expect(html).toContain("Maipu");
  });

  it("renders printable HTML with canonical totals and no raw HTML injection", () => {
    const html = renderQuotePrintableHtml(
      buildIssuedQuoteDocumentViewModel({
        snapshot: buildSnapshot(),
        renderVersion: "quote-v1",
        companyName: "Pesas Chile SPA"
      })
    );

    expect(html).toContain("Cotizacion comercial");
    expect(html).toContain("Version de render: quote-v1");
    expect(html).toContain("$31.568");
    expect(html).toContain("$5.998");
    expect(html).toContain("$37.566");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('xss')</script>");
  });

  it("matches the normalized email snapshot", () => {
    expect(normalizeHtml(buildEmailHtml())).toMatchSnapshot();
  });
});
