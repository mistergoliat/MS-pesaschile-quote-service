import { describe, expect, it, vi } from "vitest";

import { buildIssuedQuoteDocumentModelV2 } from "../../src/application/quote-v2/document/issued-quote-document-model";
import { issuerProfile, PESASCHILE_CL_V1, PESASCHILE_CL_V2, UnknownIssuerProfileError } from "../../src/application/quote-v2/document/issuer-profiles";
import { TEMPLATE_V4, TEMPLATE_V4_CONTENT_STATUS } from "../../src/application/quote-v2/document/template-v4";
import { TEMPLATE_V5, TEMPLATE_V5_CONTENT_STATUS, TEMPLATE_VERSION } from "../../src/application/quote-v2/document/template-v5";
import { issuedSnapshotHash } from "../../src/application/quote-v2/issued-snapshot";
import { createIssuedSnapshotFixture, goldenPdfFixtures, productionPdfFixtures } from "../../src/scripts/pdf-fixture";

describe("R1.7A issuer and template freeze", () => {
  it("retains exact archived issuer values and registers the owner-approved identity", () => {
    expect(issuerProfile("pesaschile-cl-v1")).toEqual({
      id: "pesaschile-cl-v1", legalName: "Pesas Chile SPA", rut: null, address: null,
      website: "www.pesaschile.cl", logoAssetId: "asset://pesaschile-brand-v1/logo-on-light", contentStatus: "provisional-u3"
    });
    expect(issuerProfile("pesaschile-cl-v2")).toEqual({
      id: "pesaschile-cl-v2", legalName: "Pesas Chile S.p.A", rut: "76.921.044-K",
      address: "Av. Monseñor Valech 12050 bodega 26, comuna de Maipú, Región Metropolitana.",
      website: "https://pesaschile.cl", logoAssetId: PESASCHILE_CL_V1.logoAssetId, contentStatus: "approved"
    });
    expect(Object.isFrozen(PESASCHILE_CL_V2)).toBe(true);
    expect(() => issuerProfile("caller-selected")).toThrow(UnknownIssuerProfileError);
  });

  it("freezes U2 approval in v5 without changing a single template word", () => {
    expect(TEMPLATE_VERSION).toBe("quote-pdf-template-v5");
    expect(TEMPLATE_V5).toEqual(TEMPLATE_V4);
    expect(TEMPLATE_V5_CONTENT_STATUS.taxWording).toBe("approved");
    expect(TEMPLATE_V4_CONTENT_STATUS.taxWording).toBe("provisional-u2");
    expect(TEMPLATE_V5.columns).toMatchObject({ unitAmount: "PRECIO UNITARIO", net: "NETO", tax: "IVA", gross: "TOTAL" });
    expect(TEMPLATE_V5.totals).toEqual({ net: "Neto", exemptNet: "Neto exento", tax: "IVA", gross: "Total" });
  });

  it("preserves historical snapshots, amounts and validity; only new identity changes the new model/hash", () => {
    const historical = goldenPdfFixtures();
    const production = productionPdfFixtures();
    for (let index = 0; index < historical.length; index++) {
      const oldSnapshot = historical[index]![1];
      const newSnapshot = production[index]![1];
      const before = JSON.stringify(oldSnapshot);
      const hash = issuedSnapshotHash(oldSnapshot);
      const oldModel = buildIssuedQuoteDocumentModelV2(oldSnapshot);
      const newModel = buildIssuedQuoteDocumentModelV2(newSnapshot);
      expect(oldModel.templateVersion).toBe("quote-pdf-template-v4");
      expect(newModel.templateVersion).toBe(TEMPLATE_VERSION);
      expect(oldModel.issuer.rows).toEqual([TEMPLATE_V4.issuerPendingNotice]);
      expect(newModel.issuer).toEqual({
        legalName: PESASCHILE_CL_V2.legalName,
        rows: [`RUT: ${PESASCHILE_CL_V2.rut}`, PESASCHILE_CL_V2.address],
        website: PESASCHILE_CL_V2.website, logoAssetId: PESASCHILE_CL_V2.logoAssetId
      });
      expect(newSnapshot.quoteId).not.toBe(oldSnapshot.quoteId);
      expect(newSnapshot.quoteNumber).not.toBe(oldSnapshot.quoteNumber);
      expect({ ...newModel, quoteNumber: oldModel.quoteNumber, issuer: oldModel.issuer, templateVersion: oldModel.templateVersion }).toEqual(oldModel);
      expect(issuedSnapshotHash(newSnapshot)).not.toBe(hash);
      expect(issuedSnapshotHash(oldSnapshot)).toBe(hash);
      expect(JSON.stringify(oldSnapshot)).toBe(before);
    }
  });

  it("frozen identity ignores live environment overrides", () => {
    const snapshot = productionPdfFixtures()[0]![1];
    const expected = buildIssuedQuoteDocumentModelV2(snapshot);
    vi.stubEnv("ISSUER_PROFILE_ID", PESASCHILE_CL_V1.id);
    vi.stubEnv("LEGAL_NAME", "Hostile override");
    try {
      expect(buildIssuedQuoteDocumentModelV2(snapshot)).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["included", "excluded", "exempt"] as const)("U2: %s line × shipping basis retains existing global-statement eligibility", (lineBasis) => {
    for (const shippingBasis of [null, "included", "excluded", "exempt"] as const) {
      const price = (basis: typeof lineBasis) => ({ amount: 10_000, taxBasis: basis, ...(basis === "exempt" ? {} : { taxRate: "0.19" }) });
      const snapshot = { ...createIssuedSnapshotFixture({
        lines: [{ description: "Prueba tributaria", price: price(lineBasis) }],
        shipping: shippingBasis === null ? null : { carrierName: "Prueba", commune: "Maipú", price: price(shippingBasis) }
      }), issuerProfileId: PESASCHILE_CL_V2.id };
      const before = JSON.stringify(snapshot);
      const model = buildIssuedQuoteDocumentModelV2(snapshot);
      const label = { included: "IVA 19% incluido", excluded: "Neto + IVA 19%", exempt: "Exento de IVA" };
      expect(model.lines[0]!.taxBasis).toBe(label[lineBasis]);
      if (shippingBasis !== null) expect(model.shipping!.taxBasis).toBe(label[shippingBasis]);
      expect(model.taxStatement).toBe(lineBasis === "included" && (shippingBasis === null || shippingBasis === "included") ? "Valores con IVA incluido." : null);
      expect(JSON.stringify(snapshot)).toBe(before);
    }
  });
});
