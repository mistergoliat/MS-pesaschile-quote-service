import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PESASCHILE_BRAND_ASSETS,
  PESASCHILE_BRAND_ASSET_IDS
} from "../../src/infrastructure/branding/assets/pesaschile-brand-assets";
import { resolveBrandAsset } from "../../src/infrastructure/branding/brand-asset-resolver";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  PESASCHILE_BRAND_VERSION
} from "../../src/infrastructure/branding/pesaschile-brand-v1";

describe("pesaschile brand v1", () => {
  it("declares the approved colors, typography, version, and brand assets", () => {
    const brand = createPesasChileBrandV1();

    expect(brand.version).toBe(PESASCHILE_BRAND_VERSION);
    expect(brand.colors).toEqual({
      primary: "#E62158",
      dark: "#1D2B35",
      light: "#ECF0F1",
      secondary: {
        caribbeanCurrent: "#01665F",
        pear: "#CCD619",
        ashGrey: "#A5BAB7"
      }
    });
    expect(brand.typography).toEqual({
      title: "Poppins Black",
      subtitle: "Poppins SemiBold",
      body: "Poppins Light",
      fallback: '"Poppins", Arial, Helvetica, sans-serif'
    });
    expect(brand.assets).toEqual({
      primaryLogo: PESASCHILE_BRAND_ASSET_IDS.primaryLogo,
      logoLight: PESASCHILE_BRAND_ASSET_IDS.logoLight,
      logoDark: PESASCHILE_BRAND_ASSET_IDS.logoDark,
      symbol: PESASCHILE_BRAND_ASSET_IDS.symbol
    });
  });

  it("resolves local assets without remote dependencies", () => {
    const brand = createPesasChileBrandV1();
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    for (const assetId of Object.values(brand.assets)) {
      expect(assetId.startsWith("http")).toBe(false);

      const resolved = resolveBrandAsset(assetId);

      expect(resolved).not.toBeNull();
      expect(resolved?.content.length).toBeGreaterThan(0);

      if (resolved?.mediaType === "image/svg+xml") {
        const svgContent = resolved.content.toString("utf8");

        expect(svgContent).toContain("<svg");
        expect(svgContent).not.toContain('href="http');
        expect(svgContent).not.toContain("href='http");
        expect(svgContent).not.toContain('src="http');
        expect(svgContent).not.toContain("src='http");
      } else {
        expect(resolved?.mediaType).toBe("image/png");
        expect(resolved?.content.subarray(0, 8).equals(pngSignature)).toBe(true);
      }
    }
  });

  it("stores the light logo, dark logo, and symbol PNG assets locally inside the brand system", () => {
    const lightLogoAsset = PESASCHILE_BRAND_ASSETS[PESASCHILE_BRAND_ASSET_IDS.logoLight];
    const darkLogoAsset = PESASCHILE_BRAND_ASSETS[PESASCHILE_BRAND_ASSET_IDS.logoDark];
    const symbolAsset = PESASCHILE_BRAND_ASSETS[PESASCHILE_BRAND_ASSET_IDS.symbol];

    expect(lightLogoAsset).toMatchObject({
      mediaType: "image/png",
      encoding: "file"
    });
    expect(darkLogoAsset).toMatchObject({
      mediaType: "image/png",
      encoding: "file"
    });
    expect(symbolAsset).toMatchObject({
      mediaType: "image/png",
      encoding: "file"
    });
    expect(
      fs.existsSync(path.resolve(process.cwd(), lightLogoAsset?.content ?? "missing-light-logo"))
    ).toBe(true);
    expect(
      fs.existsSync(path.resolve(process.cwd(), darkLogoAsset?.content ?? "missing-dark-logo"))
    ).toBe(true);
    expect(
      fs.existsSync(path.resolve(process.cwd(), symbolAsset?.content ?? "missing-symbol"))
    ).toBe(true);
  });

  it("stores the symbol PNG with transparency support", () => {
    const symbolAsset = resolveBrandAsset(PESASCHILE_BRAND_ASSET_IDS.symbol);

    expect(symbolAsset).not.toBeNull();
    expect(symbolAsset?.mediaType).toBe("image/png");
    expect(symbolAsset?.content[25]).toBe(6);
  });

  it("provides the default configurable signature with the updated corporate address", () => {
    expect(createDefaultPesasChileSenderSignatureV1()).toEqual({
      name: "Bastian Castro",
      role: "Servicio al Cliente",
      website: "www.pesaschile.cl",
      email: "sac@pesaschile.cl",
      phone: "+56 9 4222 0146",
      address: "Av. Monseñor Valech 12050, bodega 26, Maipú"
    });
  });
});
