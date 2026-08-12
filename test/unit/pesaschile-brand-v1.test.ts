import { describe, expect, it } from "vitest";

import { resolveBrandAsset } from "../../src/infrastructure/branding/brand-asset-resolver";
import {
  createPesasChileBrandV1,
  PESASCHILE_BRAND_VERSION
} from "../../src/infrastructure/branding/pesaschile-brand-v1";

describe("pesaschile brand v1", () => {
  it("declares the approved colors, typography, and version", () => {
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
  });

  it("resolves local assets without remote dependencies", () => {
    const brand = createPesasChileBrandV1();

    for (const assetId of Object.values(brand.assets)) {
      expect(assetId.startsWith("http")).toBe(false);

      const resolved = resolveBrandAsset(assetId);

      expect(resolved).not.toBeNull();
      expect(resolved?.mediaType).toBe("image/svg+xml");
      expect(resolved?.content).toContain("<svg");
      expect(resolved?.content).not.toContain("href=\"http");
      expect(resolved?.content).not.toContain("href='http");
      expect(resolved?.content).not.toContain("src=\"http");
      expect(resolved?.content).not.toContain("src='http");
    }
  });
});
