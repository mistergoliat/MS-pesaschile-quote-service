import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PESASCHILE_BRAND_ASSETS, PESASCHILE_BRAND_ASSET_IDS } from "../../src/infrastructure/branding/assets/pesaschile-brand-assets";
import { resolveBrandAsset } from "../../src/infrastructure/branding/brand-asset-resolver";

/*
 * Code-owned brand assets (logo for the PDF and the V2 email envelope). The
 * V1 brand theme with its personal signature and legal-name input was
 * removed in R1.6B; only the asset registry and resolver remain.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("brand assets", () => {
  it("resolves every asset locally, without remote references", () => {
    for (const assetId of Object.values(PESASCHILE_BRAND_ASSET_IDS)) {
      expect(assetId.startsWith("asset://")).toBe(true);
      const resolved = resolveBrandAsset(assetId);
      expect(resolved, assetId).not.toBeNull();

      if (resolved!.mediaType === "image/svg+xml") {
        const svg = resolved!.content.toString("utf8");
        expect(svg).toContain("<svg");
        expect(svg).not.toMatch(/(?:href|src)=["']http/);
      } else {
        expect(resolved!.content.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }
    }

    expect(resolveBrandAsset("asset://unknown")).toBeNull();
  });

  it("maps the light/dark logos and the symbol to versioned local PNG files", () => {
    for (const id of [PESASCHILE_BRAND_ASSET_IDS.logoOnLight, PESASCHILE_BRAND_ASSET_IDS.logoOnDark, PESASCHILE_BRAND_ASSET_IDS.symbol]) {
      const asset = PESASCHILE_BRAND_ASSETS[id]!;
      expect(asset).toMatchObject({ mediaType: "image/png", encoding: "file" });
      expect(fs.existsSync(path.resolve("src/infrastructure/branding", asset.content))).toBe(true);
    }

    // RGBA (color type 6): the symbol keeps its transparency.
    expect(resolveBrandAsset(PESASCHILE_BRAND_ASSET_IDS.symbol)!.content[25]).toBe(6);
  });
});
