import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildIssuedQuoteDocumentModelV2,
  formatCivilDate,
  formatRatePercent,
  InvalidIssuedSnapshotError
} from "../../src/application/quote-v2/document/issued-quote-document-model";
import { PESASCHILE_CL_V1, UnknownIssuerProfileError } from "../../src/application/quote-v2/document/issuer-profiles";
import { TEMPLATE_V4_CONTENT_STATUS, TEMPLATE_VERSION } from "../../src/application/quote-v2/document/template-v4";
import { buildIssuedSnapshot, type IssuedSnapshotRows } from "../../src/infrastructure/persistence/postgres/issued-snapshot-loader";
import { createIssuedSnapshotFixture, createLinesFixture, createMixedTaxFixture } from "../../src/scripts/pdf-fixture";
import { DIRECT_CREATE, DRAFT_ISSUE, GUEST_MINIMAL_SHIPPING } from "../fixtures/issued-snapshot-rows";

const VAT = { taxBasis: "included", taxRate: "0.19" } as const;
const oneLine = { description: "Kettlebell 8 kg", price: { amount: 19_990, ...VAT } };
const model = (snapshot: Parameters<typeof buildIssuedQuoteDocumentModelV2>[0]) => buildIssuedQuoteDocumentModelV2(snapshot);
const all = (value: unknown): string => JSON.stringify(value);

describe("IssuedQuoteDocumentModelV2: customer (Domain §9.1/§15)", () => {
  it("A: a guest without data shows exactly 'Cliente: no informado'; a guest with data shows only what was given", () => {
    expect(model(createIssuedSnapshotFixture({ customer: { kind: "guest" }, lines: [oneLine] })).customer).toEqual([
      { text: "Cliente: no informado", strong: false }
    ]);
    expect(model(createIssuedSnapshotFixture({ customer: { kind: "guest", displayName: "Cliente mostrador", phone: "+56 2 2345 6789" }, lines: [oneLine] })).customer).toEqual([
      { text: "Cliente mostrador", strong: true },
      { text: "Teléfono: +56 2 2345 6789", strong: false }
    ]);
  });

  it("B: person shows displayName, RUT and contact as given, omitting absent fields", () => {
    expect(
      model(
        createIssuedSnapshotFixture({
          customer: { kind: "person", displayName: "Camila Rojas", rut: "12345678-5", email: "camila@example.com", externalCustomerReference: { sourceSystem: "crm", reference: "C-1" } },
          lines: [oneLine]
        })
      ).customer
    ).toEqual([
      { text: "Camila Rojas", strong: true },
      { text: "RUT: 12345678-5", strong: false },
      { text: "Correo: camila@example.com", strong: false }
    ]);
  });

  it("C: company shows legal name, trade name, RUT, contact and address", () => {
    expect(model(createMixedTaxFixture()).customer).toEqual([
      { text: "Gimnasio Andes SpA", strong: true },
      { text: "Nombre de fantasía: Andes Fit", strong: false },
      { text: "RUT: 76123456-0", strong: false },
      { text: "Contacto: Pedro Soto", strong: false },
      { text: "Correo: compras@andesfit.example.com", strong: false },
      { text: "Av. Providencia 1234, oficina 501, Providencia, Región Metropolitana, Chile", strong: false }
    ]);
  });
});

describe("IssuedQuoteDocumentModelV2: lines, shipping, tax and totals", () => {
  it("D: structured shipping is a separate block with carrier, service, destination and frozen amounts", () => {
    const built = model(createLinesFixture(1));

    expect(built.shipping).toEqual({
      rows: ["Transportista: Starken", "Servicio: Entrega a domicilio", "Destino: Ñuñoa, Región Metropolitana"],
      amount: "$7.128",
      taxBasis: "IVA 19% incluido",
      net: "$5.990",
      tax: "$1.138",
      gross: "$7.128"
    });
    expect(built.shippingAbsent).toBeNull();
    expect(built.lines).toHaveLength(1);
  });

  it("E: no shipping → 'Despacho no incluido' and no shipping block", () => {
    const built = model(createIssuedSnapshotFixture({ lines: [oneLine] }));

    expect(built.shipping).toBeNull();
    expect(built.shippingAbsent).toBe("Despacho no incluido");
  });

  it("F/G/H/I: per-charge tax basis labels; the global VAT statement only when every charge is included", () => {
    const included = model(createLinesFixture(2));
    const mixed = model(createMixedTaxFixture());

    expect(included.lines.map((line) => line.taxBasis)).toEqual(["IVA 19% incluido", "IVA 19% incluido"]);
    expect(included.taxStatement).toBe("Valores con IVA incluido.");
    expect(mixed.lines.map((line) => line.taxBasis)).toEqual(["IVA 19% incluido", "Neto + IVA 19%", "Exento de IVA"]);
    expect(mixed.shipping?.taxBasis).toBe("Neto + IVA 19%");
    expect(mixed.taxStatement).toBeNull();
    // An included-only quote whose shipping is excluded is not "all included".
    expect(
      model(createIssuedSnapshotFixture({ lines: [oneLine], shipping: { carrierName: "X", commune: "Y", price: { amount: 5_000, taxBasis: "excluded", taxRate: "0.19" } } }))
        .taxStatement
    ).toBeNull();
  });

  it("J/K/O: displays the frozen unit amounts, line amounts and totals verbatim, with no recomputation", () => {
    const snapshot = createMixedTaxFixture();
    // Deliberately inconsistent frozen values: the document must show them, not "fix" them.
    const tampered = {
      ...snapshot,
      lines: snapshot.lines.map((line, index) => (index === 1 ? { ...line, amounts: { net: 1, tax: 2, gross: 3 } } : line)),
      totals: { net: 11, tax: 22, gross: 33, exemptNet: 44 }
    };
    const built = model(tampered);

    expect(built.lines[1]).toMatchObject({ quantity: "1,5 m²", unitAmount: "$67.667", net: "$1", tax: "$2", gross: "$3" });
    expect(built.totals).toEqual({ net: "$11", exemptNet: "$44", tax: "$22", gross: "$33" });

    const exact = model(snapshot);
    expect(snapshot.lines.map((line) => [line.unitPrice.amount, line.amounts.net, line.amounts.tax, line.amounts.gross])).toEqual([
      [189_990, 159_655, 30_335, 189_990],
      [67_667, 101_501, 19_285, 120_786],
      [45_000, 45_000, 0, 45_000]
    ]);
    expect(exact.lines.map((line) => [line.unitAmount, line.net, line.tax, line.gross])).toEqual([
      ["$189.990", "$159.655", "$30.335", "$189.990"],
      ["$67.667", "$101.501", "$19.285", "$120.786"],
      ["$45.000", "$45.000", "$0", "$45.000"]
    ]);
    expect(exact.totals.exemptNet).toBe("$45.000");
    expect(model(createLinesFixture(1)).totals.exemptNet).toBeNull();
  });

  it("O: the document model module performs no arithmetic and uses no V1 price derivation", () => {
    const source = fs.readFileSync("src/application/quote-v2/document/issued-quote-document-model.ts", "utf8");

    expect(source).not.toMatch(/formatCommercialUnitPriceDisplay|formatUtcDateDisplay|new Decimal|decimal\.js|chargeAmounts|sumTotals|new Date|Date\.now/);
    // No arithmetic operators applied to amounts (only string/array handling).
    expect(source).not.toMatch(/amounts?\.\w+\s*[-+*/]|\.amount\s*[-+*/]/);
  });

  it("lines show description, SKU and variant attributes; quantities use a decimal comma and unit labels", () => {
    const built = model(
      createIssuedSnapshotFixture({
        lines: [{ description: "Mancuerna hexagonal", sku: "MH-10", quantity: "2", attributes: [{ name: "Peso", value: "10 kg" }], price: { amount: 24_990, ...VAT } }]
      })
    );

    expect(built.lines[0]).toEqual({
      description: "Mancuerna hexagonal",
      details: ["SKU: MH-10", "Peso: 10 kg"],
      quantity: "2 unid.",
      unitAmount: "$24.990",
      taxBasis: "IVA 19% incluido",
      net: "$42.000",
      tax: "$7.980",
      gross: "$49.980"
    });
  });
});

describe("IssuedQuoteDocumentModelV2: dates, identity and exclusions", () => {
  it("L/M: issue date and inclusive validity come from the stored civil dates, never from an instant", () => {
    const built = model(
      createIssuedSnapshotFixture({
        // validUntilExclusive is 2026-10-10T03:00Z: its UTC date would be one day too late.
        issuedAt: "2026-10-05T02:30:00Z",
        issueLocalDate: "2026-10-04",
        validThroughLocalDate: "2026-10-09",
        lines: [oneLine]
      })
    );

    expect(built.issueDate).toBe("Fecha de emisión: 04/10/2026");
    expect(built.validityStatement).toBe("Válida hasta el 09/10/2026 inclusive (hora de Chile)");
    expect(all(built)).not.toContain("10/10/2026");
    expect(all(built)).not.toContain("05/10/2026");
  });

  it("formats civil dates and rates by string transformation only", () => {
    expect(formatCivilDate("2027-01-31")).toBe("31/01/2027");
    expect(() => formatCivilDate("2027-1-31")).toThrow(InvalidIssuedSnapshotError);
    expect(["0.19", "0.105", "1", "0.000001", "0.5"].map(formatRatePercent)).toEqual(["19", "10,5", "100", "0,0001", "50"]);
  });

  it("N: carries no internal ids, correlation, item references, provenance or idempotency data", () => {
    const snapshot = buildIssuedSnapshot(DIRECT_CREATE as unknown as IssuedSnapshotRows);
    const serialized = all(model(snapshot));

    for (const forbidden of [
      snapshot.quoteId,
      ...snapshot.lines.map((line) => line.lineId),
      "1042",
      "3317",
      "pesaschile-catalog",
      "price-engine-v2",
      "pesaschile-shipping",
      "ship-q-88121",
      "conv-7f3a91c2",
      "sales-integration",
      "a3d9c1e7"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(serialized).toContain("PC-000137");
    expect(Object.keys(model(snapshot)).sort()).toEqual(
      ["currencyLabel", "customer", "issueDate", "issuedAt", "issuer", "lines", "quoteNumber", "shipping", "shippingAbsent", "taxStatement", "templateVersion", "totals", "validityStatement"].sort()
    );
  });

  it("builds from real loader output for every golden snapshot fixture", () => {
    for (const rows of [DIRECT_CREATE, DRAFT_ISSUE, GUEST_MINIMAL_SHIPPING]) {
      expect(() => model(buildIssuedSnapshot(rows as unknown as IssuedSnapshotRows))).not.toThrow();
    }

    expect(model(buildIssuedSnapshot(DRAFT_ISSUE as unknown as IssuedSnapshotRows)).validityStatement).toBe(
      "Válida hasta el 20/10/2026 inclusive (hora de Chile)"
    );
  });

  it("P/Q: issuer identity comes from the versioned profile, with no personal signature, and is marked provisional (U3)", () => {
    const built = model(createLinesFixture(1));

    expect(built.issuer).toEqual({
      legalName: "Pesas Chile SPA",
      rows: ["Datos tributarios del emisor pendientes de aprobación"],
      website: "www.pesaschile.cl",
      logoAssetId: "asset://pesaschile-brand-v1/logo-on-light"
    });
    expect(PESASCHILE_CL_V1.contentStatus).toBe("provisional-u3");
    expect(TEMPLATE_V4_CONTENT_STATUS.taxWording).toBe("provisional-u2");
    expect(built.templateVersion).toBe(TEMPLATE_VERSION);
    expect(all(built)).not.toMatch(/Bastian|Castro|Servicio al Cliente|4222 0146|Valech|sac@/);
    expect(() => model({ ...createLinesFixture(1), issuerProfileId: "someone-else" })).toThrow(UnknownIssuerProfileError);
  });

  it("is pure: the same snapshot always gives the same model, independent of the environment", () => {
    const snapshot = createMixedTaxFixture();
    const before = all(model(snapshot));
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";

    try {
      expect(all(model(snapshot))).toBe(before);
    } finally {
      process.env.TZ = tz;
    }
  });
});
