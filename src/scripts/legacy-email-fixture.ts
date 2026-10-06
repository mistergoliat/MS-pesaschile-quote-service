import type { CanonicalIssuedQuoteSnapshot } from "../application/quote/documents/issued-quote-document";

/*
 * LEGACY (R1.6 email only): V1 issued-quote snapshots for the email preview
 * and Gmail smoke scripts. Not an input of the V2 formal PDF (pdf-fixture.ts).
 */

export function createLegacyEmailFixture(itemCount: number): CanonicalIssuedQuoteSnapshot {
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

export function createMixedLegacyEmailFixture(): CanonicalIssuedQuoteSnapshot {
  const fixture = createLegacyEmailFixture(3);

  return {
    ...fixture,
    quoteId: "preview-quote-mixed",
    quoteNumber: "PC-PREVIEW-MIXED",
    items: [
      {
        ...fixture.items[0]!,
        type: "product",
        sku: "BAL-001",
        description: "Balanza industrial de plataforma 300 kg"
      },
      {
        ...fixture.items[1]!,
        type: "service",
        sku: null,
        description: "Instalación y calibración en terreno"
      },
      {
        ...fixture.items[2]!,
        type: "shipping",
        externalSource: null,
        externalItemId: null,
        externalVariantId: null,
        sku: null,
        description: "Despacho a domicilio"
      }
    ]
  };
}
