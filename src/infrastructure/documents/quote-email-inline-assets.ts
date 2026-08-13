import { resolveBrandAsset } from "../branding/brand-asset-resolver";
import { PESASCHILE_BRAND_ASSET_IDS } from "../branding/assets/pesaschile-brand-assets";

export const QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID = "pesaschile-logo-light";
export const QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID = "pesaschile-logo-dark";

export interface QuoteEmailInlineAsset {
  readonly contentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

function getBrandAssetFilename(mediaType: string): string {
  return mediaType === "image/png" ? "pesaschile-logo.png" : "pesaschile-logo.svg";
}

export function resolveQuoteEmailInlineAssets(html: string): readonly QuoteEmailInlineAsset[] {
  const requestedInlineAssets = [
    {
      contentId: QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID,
      assetId: PESASCHILE_BRAND_ASSET_IDS.logoLight,
      filename: "pesaschile-logo-light.png"
    },
    {
      contentId: QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
      assetId: PESASCHILE_BRAND_ASSET_IDS.logoDark,
      filename: "pesaschile-logo-dark.png"
    }
  ].filter((asset) => html.includes(`cid:${asset.contentId}`));

  if (requestedInlineAssets.length === 0) {
    return [];
  }

  return requestedInlineAssets.flatMap((asset) => {
    const resolvedLogo = resolveBrandAsset(asset.assetId);

    if (!resolvedLogo) {
      return [];
    }

    return [
      {
        contentId: asset.contentId,
        filename:
          resolvedLogo.mediaType === "image/png"
            ? asset.filename
            : getBrandAssetFilename(resolvedLogo.mediaType),
        contentType: resolvedLogo.mediaType,
        content: resolvedLogo.content
      }
    ];
  });
}
