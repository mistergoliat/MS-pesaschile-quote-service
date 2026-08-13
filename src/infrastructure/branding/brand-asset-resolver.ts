import fs from "node:fs";
import path from "node:path";

import { PESASCHILE_BRAND_ASSETS } from "./assets/pesaschile-brand-assets";

export interface ResolvedBrandAsset {
  readonly id: string;
  readonly mediaType: "image/svg+xml" | "image/png";
  readonly content: Buffer;
}

export function resolveBrandAsset(assetId: string): ResolvedBrandAsset | null {
  const asset = PESASCHILE_BRAND_ASSETS[assetId];

  if (!asset) {
    return null;
  }

  const content =
    asset.encoding === "file"
      ? fs.readFileSync(resolveAssetFilePath(asset.content))
      : Buffer.from(asset.content, asset.encoding);

  return {
    id: assetId,
    mediaType: asset.mediaType,
    content
  };
}

function resolveAssetFilePath(value: string): string {
  const projectRelativePath = path.resolve(__dirname, "..", "..", "..", value);

  if (fs.existsSync(projectRelativePath)) {
    return projectRelativePath;
  }

  return path.resolve(process.cwd(), value);
}
