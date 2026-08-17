import fsPromises from "node:fs/promises";
import path from "node:path";

import { buildCanonicalIssuedQuoteSnapshot } from "../application/quote/documents/issued-quote-document";
import type { QuoteSnapshot } from "../domain";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "../infrastructure/branding/pesaschile-brand-v1";
import { renderQuoteEmailHtml } from "../infrastructure/documents/document-templates";
import { buildQuoteEmailViewModel } from "../infrastructure/documents/quote-email-view-model";

function buildPreviewQuoteSnapshot(): QuoteSnapshot {
  return {
    quoteId: "preview-quote-1",
    quoteNumber: "PC-009001",
    opportunityId: "opp-preview-1",
    customerId: "customer-preview-1",
    conversationId: "conversation-preview-1",
    actor: {
      type: "sales_agent",
      id: "preview-agent"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "preview-corr-1"
    },
    status: "draft",
    currency: "CLP",
    customerSnapshot: {
      name: "Ana Gonzalez",
      businessName: "Frigorifico Andes SPA",
      email: "ana.gonzalez@example.com",
      phone: "+56 9 6123 4567",
      address: "Camino Industrial 480",
      district: "Maipu",
      region: "RM"
    },
    items: [
      {
        lineId: "preview-line-1",
        type: "product",
        externalSource: "catalog_service",
        externalItemId: "sku-balanza-300",
        externalVariantId: null,
        sku: "BAL-300",
        description: "Bascula industrial 300 kg con indicador digital",
        quantity: "2",
        unitPrice: "499000",
        taxIncluded: true,
        taxRate: "0.19",
        lineSubtotal: "838655",
        lineTax: "159345",
        lineTotal: "998000"
      },
      {
        lineId: "preview-line-2",
        type: "service",
        externalSource: null,
        externalItemId: "svc-cal-01",
        externalVariantId: null,
        sku: "SVC-CAL",
        description: "Servicio de calibracion y puesta en marcha",
        quantity: "1",
        unitPrice: "85000",
        taxIncluded: false,
        taxRate: "0.19",
        lineSubtotal: "85000",
        lineTax: "16150",
        lineTotal: "101150"
      }
    ],
    pricing: {
      subtotal: "923655",
      taxAmount: "175495",
      total: "1099150"
    },
    validUntil: "2026-08-17T00:00:00.000Z",
    version: 1,
    revisionRootId: "preview-quote-1",
    previousRevisionId: null,
    supersedesQuoteId: null,
    supersededByQuoteId: null,
    issuedDocument: null,
    timestamps: {
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
      issuedAt: null,
      acceptedAt: null,
      paidAt: null,
      cancelledAt: null,
      expiredAt: null
    }
  };
}

function forceColorSchemePreviewHtml(html: string, scheme: "dark"): string {
  return html.replace("<html lang=\"es\">", `<html lang="es" data-force-color-scheme="${scheme}">`);
}

async function main(): Promise<void> {
  const snapshot = buildCanonicalIssuedQuoteSnapshot(
    buildPreviewQuoteSnapshot(),
    "2026-08-12T12:30:00.000Z"
  );
  const html = renderQuoteEmailHtml(
    buildQuoteEmailViewModel({
      snapshot,
      brand: createPesasChileBrandV1(),
      emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
      senderSignature: createDefaultPesasChileSenderSignatureV1()
    })
  );
  const outputDirectory = path.resolve(process.cwd(), ".tmp-previews");
  const defaultOutputPath = path.join(outputDirectory, "quote-email-v2-preview.html");
  const lightOutputPath = path.join(outputDirectory, "quote-email-v2-preview-light.html");
  const darkOutputPath = path.join(outputDirectory, "quote-email-v2-preview-dark.html");

  await fsPromises.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fsPromises.writeFile(defaultOutputPath, html, "utf8"),
    fsPromises.writeFile(lightOutputPath, html, "utf8"),
    fsPromises.writeFile(darkOutputPath, forceColorSchemePreviewHtml(html, "dark"), "utf8")
  ]);

  console.log(defaultOutputPath);
  console.log(lightOutputPath);
  console.log(darkOutputPath);
}

void main();
