import type { BrandTheme, SenderSignature } from "./brand-theme";
import { PESASCHILE_BRAND_ASSET_IDS } from "./assets/pesaschile-brand-assets";

export const PESASCHILE_BRAND_VERSION = "pesaschile-brand-v1";
export const QUOTE_EMAIL_TEMPLATE_VERSION = "quote-email-v2";
export const QUOTE_EMAIL_VALIDITY_POLICY_DAYS = 5;

export function createPesasChileBrandV1(input: {
  readonly legalName?: string;
} = {}): BrandTheme {
  return {
    id: "pesaschile",
    version: PESASCHILE_BRAND_VERSION,
    company: {
      displayName: "PesasChile",
      legalName: input.legalName ?? "Pesas Chile SPA",
      website: "www.pesaschile.cl"
    },
    colors: {
      primary: "#E62158",
      dark: "#1D2B35",
      light: "#ECF0F1",
      secondary: {
        caribbeanCurrent: "#01665F",
        pear: "#CCD619",
        ashGrey: "#A5BAB7"
      }
    },
    typography: {
      title: "Poppins Black",
      subtitle: "Poppins SemiBold",
      body: "Poppins Light",
      fallback: '"Poppins", Arial, Helvetica, sans-serif'
    },
    assets: {
      primaryLogo: PESASCHILE_BRAND_ASSET_IDS.primaryLogo,
      logoLight: PESASCHILE_BRAND_ASSET_IDS.logoLight,
      logoDark: PESASCHILE_BRAND_ASSET_IDS.logoDark,
      symbol: PESASCHILE_BRAND_ASSET_IDS.symbol
    }
  };
}

export function createDefaultPesasChileSenderSignatureV1(): SenderSignature {
  return {
    name: "Bastian Castro",
    role: "Servicio al Cliente",
    website: "www.pesaschile.cl",
    email: "sac@pesaschile.cl",
    phone: "+56 9 4222 0146",
    address: "Av. Monseñor Valech 12050, bodega 26, Maipú"
  };
}
