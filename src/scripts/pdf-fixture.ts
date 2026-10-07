import { chargeAmounts, sumTotals, type TaxBasis } from "../application/quote-v2/arithmetic";
import {
  buildIssuedQuoteDocumentModelV2,
  type IssuedQuoteDocumentModelV2
} from "../application/quote-v2/document/issued-quote-document-model";
import type { IssuedCharge, IssuedLine, IssuedShipping, IssuedSnapshot } from "../application/quote-v2/issued-snapshot";
import { NativePdfRenderer } from "../infrastructure/documents/native-pdf-renderer";
import { PESASCHILE_CL_V2 } from "../application/quote-v2/document/issuer-profiles";

/*
 * Synthetic, non-sensitive issued snapshots for the formal PDF (previews,
 * benchmarks, smoke scripts and tests). Amounts come from the owner
 * arithmetic at fixture construction, exactly as acceptance freezes them; the
 * document path itself never computes an amount.
 */

export function createPdfRenderer(): NativePdfRenderer {
  return new NativePdfRenderer();
}

export interface FixtureCharge {
  readonly amount: number;
  readonly taxBasis: TaxBasis;
  readonly taxRate?: string;
}

export interface FixtureLine {
  readonly description: string;
  readonly quantity?: string;
  readonly unit?: string;
  readonly sku?: string;
  readonly attributes?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly kind?: "product" | "service";
  readonly price: FixtureCharge;
}

export interface FixtureShipping {
  readonly carrierName: string;
  readonly serviceTypeName?: string;
  readonly commune: string;
  readonly region?: string;
  readonly price: FixtureCharge;
}

const VAT_INCLUDED = { taxBasis: "included", taxRate: "0.19" } as const;

const issuedCharge = (price: FixtureCharge): IssuedCharge =>
  price.taxBasis === "exempt" ? { amount: price.amount, taxBasis: "exempt" } : { amount: price.amount, taxBasis: price.taxBasis, taxRate: price.taxRate ?? "0.19" };

const frozen = (price: FixtureCharge, quantity: string) => {
  const charge = issuedCharge(price);
  return chargeAmounts(charge.amount, quantity, price.taxBasis, charge.taxRate);
};

const toNumbers = (value: { net: bigint; tax: bigint; gross: bigint }) => ({ net: Number(value.net), tax: Number(value.tax), gross: Number(value.gross) });

export function createIssuedSnapshotFixture(input: {
  readonly quoteNumber?: string;
  readonly issuedAt?: string;
  readonly issueLocalDate?: string;
  readonly validThroughLocalDate?: string;
  readonly customer?: Readonly<Record<string, unknown>>;
  readonly lines: readonly FixtureLine[];
  readonly shipping?: FixtureShipping | null;
}): IssuedSnapshot {
  const charges = input.lines.map((line) => ({ amounts: frozen(line.price, line.quantity ?? "1"), basis: line.price.taxBasis }));
  const lines: IssuedLine[] = input.lines.map((line, index) => ({
    lineId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    position: index + 1,
    kind: line.kind ?? "product",
    item: {
      sourceSystem: "fixture-catalog",
      productRef: `fixture-product-${index + 1}`,
      ...(line.sku ? { sku: line.sku } : {}),
      description: line.description,
      ...(line.attributes && line.attributes.length > 0 ? { attributes: line.attributes } : {})
    },
    quantity: { value: line.quantity ?? "1", unit: line.unit ?? "unit" },
    unitPrice: issuedCharge(line.price),
    pricingProvenance: { sourceSystem: "fixture-catalog", reference: "fixture-price-ref", asOf: "2026-10-04T17:58:12Z" },
    amounts: toNumbers(charges[index]!.amounts)
  }));
  const shippingInput = input.shipping ?? null;
  const shippingAmounts = shippingInput ? frozen(shippingInput.price, "1") : null;
  const shipping: IssuedShipping | null =
    shippingInput && shippingAmounts
      ? {
          carrier: { code: "fixture-carrier", name: shippingInput.carrierName },
          ...(shippingInput.serviceTypeName ? { serviceType: { name: shippingInput.serviceTypeName } } : {}),
          destination: { commune: shippingInput.commune, ...(shippingInput.region ? { region: shippingInput.region } : {}), country: "CL" },
          amount: issuedCharge(shippingInput.price),
          sourceQuote: { sourceSystem: "fixture-shipping", reference: "fixture-shipping-ref", asOf: "2026-10-04T17:59:01Z" },
          amounts: toNumbers(shippingAmounts)
        }
      : null;
  const totals = sumTotals([...charges, ...(shippingInput && shippingAmounts ? [{ amounts: shippingAmounts, basis: shippingInput.price.taxBasis }] : [])]);

  return {
    quoteId: "0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10",
    quoteNumber: input.quoteNumber ?? "PC-000137",
    currency: "CLP",
    issuerProfileId: "pesaschile-cl-v1",
    issuedAt: input.issuedAt ?? "2026-10-04T18:00:00Z",
    validity: {
      source: "policy",
      policyId: "cl-retail-5-calendar-days-v1",
      issuerZone: "America/Santiago",
      tzdbVersion: "2025b",
      issueLocalDate: input.issueLocalDate ?? "2026-10-04",
      validThroughLocalDate: input.validThroughLocalDate ?? "2026-10-09",
      validUntilExclusive: "2026-10-10T03:00:00Z",
      override: null
    },
    customer: input.customer ?? { kind: "person", displayName: "Camila Rojas", email: "camila.rojas@example.com", phone: "+56 9 1234 5678" },
    lines,
    shipping,
    totals: { ...toNumbers(totals), exemptNet: Number(totals.exemptNet) }
  };
}

/** `count` catalog lines, all tax-included, with long descriptions and variant attributes, plus structured shipping. */
export function createLinesFixture(count: number): IssuedSnapshot {
  return createIssuedSnapshotFixture({
    quoteNumber: `PC-${String(900_000 + count).padStart(6, "0")}`,
    lines: Array.from({ length: count }, (_, index) => ({
      description:
        index % 3 === 0
          ? `Descripción extensa del producto de prueba número ${index + 1}, con texto adicional para validar el ajuste de línea y la paginación del documento formal.`
          : `Producto de prueba ${index + 1}`,
      sku: `SKU-${String(index + 1).padStart(3, "0")}`,
      quantity: index % 4 === 0 ? "2" : "1",
      ...(index % 5 === 0 ? { attributes: [{ name: "Peso", value: `${index + 5} kg` }] } : {}),
      price: { ...VAT_INCLUDED, amount: 24_990 + index * 10 }
    })),
    shipping: { carrierName: "Starken", serviceTypeName: "Entrega a domicilio", commune: "Ñuñoa", region: "Región Metropolitana", price: { ...VAT_INCLUDED, amount: 7_128 } }
  });
}

export function createPdfFixture(count: number): IssuedQuoteDocumentModelV2 {
  return buildIssuedQuoteDocumentModelV2(createLinesFixture(count));
}

/** Company customer, mixed included/excluded/exempt charges and a fractional quantity, net-priced shipping. */
export function createMixedTaxFixture(): IssuedSnapshot {
  return createIssuedSnapshotFixture({
    quoteNumber: "PC-000138",
    customer: {
      kind: "company",
      legalName: "Gimnasio Andes SpA",
      tradeName: "Andes Fit",
      rut: "76123456-0",
      contactName: "Pedro Soto",
      email: "compras@andesfit.example.com",
      address: { lines: ["Av. Providencia 1234, oficina 501"], commune: "Providencia", region: "Región Metropolitana", country: "CL" }
    },
    lines: [
      { description: "Balanza industrial de plataforma 300 kg", sku: "BAL-001", price: { amount: 189_990, ...VAT_INCLUDED } },
      { description: "Caucho de piso 1 m²", quantity: "1.5", unit: "m2", price: { amount: 67_667, taxBasis: "excluded", taxRate: "0.19" } },
      { description: "Instalación y calibración en terreno", kind: "service", unit: "service", price: { amount: 45_000, taxBasis: "exempt" } }
    ],
    shipping: { carrierName: "PC Carrier", commune: "Providencia", price: { amount: 5_990, taxBasis: "excluded", taxRate: "0.19" } }
  });
}

const VAT = { taxBasis: "included", taxRate: "0.19" } as const;

/**
 * Golden formal-PDF fixtures: every customer kind, with and without shipping,
 * all-included and mixed tax bases, long descriptions, 100 lines, Latin
 * Extended and the supported symbol set. Their SHA-256 values are pinned in
 * test/unit/native-pdf-renderer.test.ts and must be identical on Windows and
 * in the Linux runtime image.
 */
export function goldenPdfFixtures(): ReadonlyArray<readonly [string, IssuedSnapshot]> {
  return [
    ["person-shipping-included", createLinesFixture(3)],
    ["company-mixed-tax", createMixedTaxFixture()],
    [
      "guest-no-data-no-shipping",
      createIssuedSnapshotFixture({ customer: { kind: "guest" }, lines: [{ description: "Kettlebell 8 kg", price: { amount: 19_990, ...VAT } }] })
    ],
    [
      "guest-with-contact",
      createIssuedSnapshotFixture({
        customer: { kind: "guest", displayName: "Cliente mostrador", phone: "+56 2 2345 6789" },
        lines: [{ description: "Disco olímpico 20 kg", quantity: "4", price: { amount: 39_990, ...VAT } }],
        shipping: { carrierName: "Retiro coordinado", commune: "Santiago", price: { amount: 0, taxBasis: "exempt" } }
      })
    ],
    [
      "long-descriptions",
      createIssuedSnapshotFixture({
        lines: Array.from({ length: 4 }, (_, index) => ({
          description: `${"Balanza industrial de plataforma reforzada para operaciones logísticas, con estructura de acero, indicador digital y nivelación regulable. ".repeat(2)}Ítem ${index + 1}.`.slice(0, 300),
          sku: `BAL-${index + 1}`,
          attributes: [
            { name: "Capacidad", value: "300 kg" },
            { name: "Dimensiones", value: "60 × 80 cm" }
          ],
          price: { amount: 189_990, ...VAT }
        }))
      })
    ],
    ["hundred-lines", createLinesFixture(100)],
    [
      "unicode-latin-extended",
      createIssuedSnapshotFixture({
        customer: { kind: "company", legalName: "Łódź Ősi Trading Sp. z o.o.", contactName: "Ñandú Peñalolén", address: { lines: ["Ulica Piotrkowska 1"], country: "CL" } },
        lines: [{ description: "Señalética ≤ 50 cm ≥ 10 cm → ✓ «calidad» € 1½", sku: "SEÑ-01", price: { amount: 9_990, ...VAT } }]
      })
    ]
  ];
}

/** New synthetic acceptances with distinct ids/numbers and approved issuer v2.
 * Reuse only synthetic commercial scenarios; archived snapshots stay v1.
 */
export function productionPdfFixtures(): ReadonlyArray<readonly [string, IssuedSnapshot]> {
  const fixtures: ReadonlyArray<readonly [string, IssuedSnapshot]> = [
    ...goldenPdfFixtures(),
    ["excluded-no-shipping", createIssuedSnapshotFixture({
      customer: { kind: "person", displayName: "Cliente de prueba" },
      lines: [{ description: "Balanza de prueba", price: { amount: 100_000, taxBasis: "excluded", taxRate: "0.19" } }]
    })],
    ["exempt-no-shipping", createIssuedSnapshotFixture({
      customer: { kind: "guest" },
      lines: [{ description: "Servicio de prueba", kind: "service", price: { amount: 45_000, taxBasis: "exempt" } }]
    })]
  ];
  return fixtures.map(([name, snapshot], index) => [name, {
    ...snapshot,
    quoteId: `17000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    quoteNumber: `PC-${1_700_001 + index}`,
    issuerProfileId: PESASCHILE_CL_V2.id
  }] as const);
}
