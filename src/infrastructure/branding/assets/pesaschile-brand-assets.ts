export const PESASCHILE_BRAND_ASSET_IDS = {
  primaryLogo: "asset://pesaschile-brand-v1/primary-logo",
  logoLight: "asset://pesaschile-brand-v1/logo-light",
  logoDark: "asset://pesaschile-brand-v1/logo-dark",
  symbol: "asset://pesaschile-brand-v1/symbol"
} as const;

export interface BrandAssetDefinition {
  readonly mediaType: "image/svg+xml" | "image/png";
  readonly encoding: "utf8" | "base64" | "file";
  readonly content: string;
}

export const PESASCHILE_BRAND_ASSETS: Record<string, BrandAssetDefinition> = {
  [PESASCHILE_BRAND_ASSET_IDS.primaryLogo]: {
    mediaType: "image/svg+xml",
    encoding: "utf8",
    content: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64" role="img" aria-labelledby="titlePrimary">',
      '<title id="titlePrimary">PesasChile</title>',
      '<rect width="240" height="64" rx="14" fill="#1D2B35"/>',
      '<rect x="10" y="10" width="44" height="44" rx="12" fill="#E62158"/>',
      '<path d="M24 24h16v5H24zm-4 7h24v5H20zm4 7h16v5H24z" fill="#ECF0F1"/>',
      '<text x="68" y="30" fill="#ECF0F1" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="22" font-weight="800">Pesas</text>',
      '<text x="138" y="30" fill="#E62158" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="22" font-weight="800">Chile</text>',
      '<text x="68" y="48" fill="#A5BAB7" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="10" font-weight="600" letter-spacing="1.2">SOLUCIONES DE PESAJE</text>',
      "</svg>"
    ].join("")
  },
  [PESASCHILE_BRAND_ASSET_IDS.logoLight]: {
    mediaType: "image/png",
    encoding: "file",
    content: "src/infrastructure/branding/assets/files/logo-light.png"
  },
  [PESASCHILE_BRAND_ASSET_IDS.logoDark]: {
    mediaType: "image/png",
    encoding: "file",
    content: "src/infrastructure/branding/assets/files/logo-dark.png"
  },
  [PESASCHILE_BRAND_ASSET_IDS.symbol]: {
    mediaType: "image/png",
    encoding: "file",
    content: "src/infrastructure/branding/assets/files/symbol.png"
  }
};
