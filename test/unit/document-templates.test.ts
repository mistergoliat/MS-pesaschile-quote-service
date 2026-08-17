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
import {
  QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
  QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID
} from "../../src/infrastructure/documents/quote-email-inline-assets";
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
        externalSource: null,
        externalItemId: null,
        externalVariantId: null,
        sku: "SKU-9",
        description: 'Servicio "Premium" & <img src=x onerror=alert(1)>',
        quantity: "1.000000",
        unitPrice: "31568",
        taxIncluded: false,
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
  it("renders email HTML with dual logo CIDs and a light-by-default header", () => {
    const html = buildEmailHtml();

    expect(html).toContain(`cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}`);
    expect(html).toContain(`cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}`);
    expect(html).toContain('alt="Pesas Chile"');
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('name="supported-color-schemes" content="light dark"');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('html[data-force-color-scheme="dark"] .quote-email__brand-logo--surface-light .quote-email__brand-logo-dark');
    expect(html).toContain('class="quote-email__header-surface"');
    expect(html).toContain('class="quote-email__brand-logo quote-email__brand-logo--surface-light"');
    expect(html).toContain('class="quote-email__brand-logo quote-email__brand-logo--surface-dark"');
    expect(html).toContain('class="quote-email__brand-logo-dark"');
    expect(html).toContain('class="quote-email__brand-logo-light"');
    expect(html).toContain('display:block;width:220px');
    expect(html).toContain('background:#F7F9FA;');
    expect(html).toContain("background:#1D2B35");
    expect(html).toContain(".quote-email__header-surface {\n        background:#1D2B35 !important;");
    expect(html).toContain(".quote-email__header-number,\n      .quote-email__header-issued {\n        color:#ECF0F1 !important;");
    expect(html).toContain("PC-000777");
    expect(html).toContain("12 AGO 2026");
    expect(html).toContain("17 AGO 2026");
    expect(html).toContain("Precios incluyen IVA");
    expect(html).toContain("$37.566");
    expect(html).toContain("Bastian Castro");
    expect(html).toContain("sac@pesaschile.cl");
    expect(html).toContain("www.pesaschile.cl");
    expect(html).not.toContain('width="148"');
    expect(html).not.toContain("pesaschile-symbol");
    expect(html).not.toContain("filter:");
    expect(html).not.toContain("invert(");
    expect(html).not.toContain("mix-blend-mode");
  });

  it("keeps the light logo visible by default in the header and hides the dark logo inline", () => {
    const html = buildEmailHtml();

    expect(html).toContain(
      `<img class="quote-email__brand-logo-dark" src="cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}" alt="Pesas Chile" width="220" style="display:none;width:220px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;max-height:0;overflow:hidden;mso-hide:all;" />`
    );
    expect(html).toContain(
      `<img class="quote-email__brand-logo-light" src="cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}" alt="Pesas Chile" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />`
    );
  });

  it("forces the dark logo visible in dark mode and neutralizes the hidden inline state", () => {
    const html = buildEmailHtml();

    expect(html).toContain(
      ".quote-email__brand-logo-light {\n        display:none !important;\n        max-height:0 !important;\n        overflow:hidden !important;\n        mso-hide:all !important;"
    );
    expect(html).toContain(
      ".quote-email__brand-logo-dark {\n        display:block !important;\n        max-height:none !important;\n        overflow:visible !important;\n        mso-hide:none !important;"
    );
    expect(html).toContain(
      "html[data-force-color-scheme=\"dark\"] .quote-email__brand-logo-light {\n      display:none !important;\n      max-height:0 !important;\n      overflow:hidden !important;\n      mso-hide:all !important;"
    );
    expect(html).toContain(
      "html[data-force-color-scheme=\"dark\"] .quote-email__brand-logo-dark {\n      display:block !important;\n      max-height:none !important;\n      overflow:visible !important;\n      mso-hide:none !important;"
    );
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
        address: "Av. Monsenor Valech 12050, bodega 26, Maipu"
      }
    });

    expect(html).not.toContain(">Empresa<");
    expect(html).not.toContain(">Email<");
    expect(html).not.toContain(">Telefono<");
    expect(html).not.toContain("Facebook");
    expect(html).toContain("Av. Monsenor Valech 12050, bodega 26, Maipu");
  });

  it("renders printable HTML without visible technical versioning and with commercial pricing", () => {
    const html = renderQuotePrintableHtml(
      buildIssuedQuoteDocumentViewModel({
        snapshot: buildSnapshot(),
        renderVersion: "quote-v1",
        companyName: "Pesas Chile SPA"
      })
    );

    expect(html).toContain("Cotizacion comercial");
    expect(html).toContain("Precios incluyen IVA");
    expect(html).toContain("$37.566");
    expect(html).not.toContain("Version de render:");
    expect(html).not.toContain("Quote Service");
  });

  it("matches the normalized email snapshot", () => {
    expect(normalizeHtml(buildEmailHtml())).toMatchSnapshot();
  });
});
