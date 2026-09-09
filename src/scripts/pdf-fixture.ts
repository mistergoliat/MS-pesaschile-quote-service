import type { CanonicalIssuedQuoteSnapshot } from "../application/quote/documents/issued-quote-document";
import { NativePdfRenderer } from "../infrastructure/documents/native-pdf-renderer";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1
} from "../infrastructure/branding/pesaschile-brand-v1";

export function createPdfRenderer(): NativePdfRenderer {
  return new NativePdfRenderer({
    renderVersion: "quote-pdf-v2-pdfmake",
    brand: createPesasChileBrandV1(),
    senderSignature: createDefaultPesasChileSenderSignatureV1()
  });
}

export function createPdfFixture(itemCount: number): CanonicalIssuedQuoteSnapshot {
  return {
    quoteId: `benchmark-quote-${itemCount}`,
    quoteNumber: `PC-BENCH-${itemCount}`,
    opportunityId: "benchmark-opportunity",
    customerId: "benchmark-customer",
    conversationId: "benchmark-conversation",
    currency: "CLP",
    issuedAt: "2026-09-09T12:00:00.000Z",
    validUntil: "2026-09-14T12:00:00.000Z",
    customerSnapshot: {
      name: "Cliente de prueba con un nombre suficientemente largo para probar wrapping",
      businessName: "Empresa Demo de Soluciones de Pesaje y Logística SpA",
      email: "cliente-benchmark@example.com",
      phone: "+56 9 1234 5678",
      address: "Av. Principal 123456, oficina 987, edificio corporativo",
      district: "Santiago Centro",
      region: "Región Metropolitana"
    },
    items: Array.from({ length: itemCount }, (_, index) => ({
      lineId: `line-${index + 1}`,
      type: index % 2 === 0 ? ("product" as const) : ("service" as const),
      externalSource: "benchmark-catalog",
      externalItemId: `external-item-${index + 1}`,
      externalVariantId: null,
      sku: `SKU-${String(index + 1).padStart(3, "0")}`,
      description:
        index % 3 === 0
          ? `Descripción extensa del producto o servicio de prueba número ${index + 1}, con texto adicional para validar wrapping y paginación.`
          : `Producto o servicio de prueba ${index + 1}`,
      quantity: "1.000000",
      unitPrice: "10000",
      taxIncluded: false,
      taxRate: "0.19",
      lineSubtotal: "10000",
      lineTax: "1900",
      lineTotal: "11900"
    })),
    pricing: {
      subtotal: String(itemCount * 10000),
      taxAmount: String(itemCount * 1900),
      total: String(itemCount * 11900)
    }
  };
}
