export const PESASCHILE_BRAND_ASSET_IDS = {
  primaryLogo: "asset://pesaschile-brand-v1/primary-logo",
  horizontalLogo: "asset://pesaschile-brand-v1/horizontal-logo",
  symbol: "asset://pesaschile-brand-v1/symbol"
} as const;

export const PESASCHILE_BRAND_ASSETS: Record<string, string> = {
  [PESASCHILE_BRAND_ASSET_IDS.primaryLogo]: [
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64" role="img" aria-labelledby="titlePrimary">',
    "<title id=\"titlePrimary\">PesasChile</title>",
    '<rect width="240" height="64" rx="14" fill="#1D2B35"/>',
    '<rect x="10" y="10" width="44" height="44" rx="12" fill="#E62158"/>',
    '<path d="M24 24h16v5H24zm-4 7h24v5H20zm4 7h16v5H24z" fill="#ECF0F1"/>',
    '<text x="68" y="30" fill="#ECF0F1" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="22" font-weight="800">Pesas</text>',
    '<text x="138" y="30" fill="#E62158" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="22" font-weight="800">Chile</text>',
    '<text x="68" y="48" fill="#A5BAB7" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="10" font-weight="600" letter-spacing="1.2">SOLUCIONES DE PESAJE</text>',
    "</svg>"
  ].join(""),
  [PESASCHILE_BRAND_ASSET_IDS.horizontalLogo]: [
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40" role="img" aria-labelledby="titleHorizontal">',
    "<title id=\"titleHorizontal\">PesasChile</title>",
    '<rect width="220" height="40" rx="12" fill="#1D2B35"/>',
    '<rect x="8" y="8" width="24" height="24" rx="7" fill="#E62158"/>',
    '<path d="M14 15h12v3H14zm-3 5h18v3H11zm3 5h12v3H14z" fill="#ECF0F1"/>',
    '<text x="42" y="25" fill="#ECF0F1" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="18" font-weight="800">Pesas</text>',
    '<text x="100" y="25" fill="#E62158" font-family="Poppins, Arial, Helvetica, sans-serif" font-size="18" font-weight="800">Chile</text>',
    "</svg>"
  ].join(""),
  [PESASCHILE_BRAND_ASSET_IDS.symbol]: [
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44" role="img" aria-labelledby="titleSymbol">',
    "<title id=\"titleSymbol\">PesasChile símbolo</title>",
    '<rect width="44" height="44" rx="12" fill="#E62158"/>',
    '<path d="M14 14h16v5H14zm-4 8h24v5H10zm4 8h16v5H14z" fill="#ECF0F1"/>',
    "</svg>"
  ].join("")
};
