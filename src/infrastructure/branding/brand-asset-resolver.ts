import { PESASCHILE_BRAND_ASSETS } from "./assets/pesaschile-brand-assets";

export interface ResolvedBrandAsset {
  readonly id: string;
  readonly mediaType: "image/svg+xml";
  readonly content: string;
}

export function resolveBrandAsset(assetId: string): ResolvedBrandAsset | null {
  const content = PESASCHILE_BRAND_ASSETS[assetId];

  if (!content) {
    return null;
  }

  return {
    id: assetId,
    mediaType: "image/svg+xml",
    content
  };
}
