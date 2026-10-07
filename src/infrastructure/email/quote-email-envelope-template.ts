import type { EmailEnvelope } from "../../application/quote-v2/delivery/email-envelope";
import type { OutboundMailInlineAsset } from "../../application/quote-v2/delivery/mail-sender-port";
import { PESASCHILE_BRAND_ASSET_IDS } from "../branding/assets/pesaschile-brand-assets";
import { resolveBrandAsset } from "../branding/brand-asset-resolver";
import { escapeHtml } from "../documents/html-escaping";

/*
 * HTML rendering of the V2 email envelope (R1.6B). Every dynamic value is
 * plain text from `EmailEnvelope` and goes through `escapeHtml`; colors,
 * layout, the logo CID and its bytes are code constants. There are no
 * dynamic links, no external images and no configuration values in the body.
 */

const LOGO_CONTENT_ID = "pesaschile-logo";
const COLORS = { primary: "#E62158", dark: "#1D2B35", surface: "#F7F9FA", muted: "#6B7B85" } as const;
const FONT = '"Poppins", Arial, Helvetica, sans-serif';

export interface RenderedEmailEnvelope {
  readonly html: string;
  readonly inlineAssets: readonly OutboundMailInlineAsset[];
}

function logo(): { readonly html: string; readonly assets: readonly OutboundMailInlineAsset[] } {
  const resolved = resolveBrandAsset(PESASCHILE_BRAND_ASSET_IDS.logoOnLight);

  if (!resolved || resolved.mediaType !== "image/png") {
    return {
      html: `<div style="font-family:${FONT};font-size:24px;line-height:28px;font-weight:800;color:${COLORS.dark};">Pesas Chile</div>`,
      assets: []
    };
  }

  return {
    html: `<img src="cid:${LOGO_CONTENT_ID}" alt="Pesas Chile" width="180" style="display:block;width:180px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />`,
    assets: [{ contentId: LOGO_CONTENT_ID, filename: "pesaschile-logo.png", contentType: "image/png", content: resolved.content }]
  };
}

export function renderEmailEnvelopeHtml(envelope: EmailEnvelope): RenderedEmailEnvelope {
  const brand = logo();
  const paragraph = (text: string) =>
    `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${COLORS.dark};">${escapeHtml(text)}</p>`;

  const html = [
    "<!DOCTYPE html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${escapeHtml(envelope.subject)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background:${COLORS.surface};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.surface};">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:8px;">',
    `<tr><td style="padding:24px 32px;border-bottom:4px solid ${COLORS.primary};">${brand.html}</td></tr>`,
    '<tr><td style="padding:32px;">',
    paragraph(envelope.greeting),
    ...envelope.paragraphs.map(paragraph),
    `<p style="margin:24px 0 0 0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:700;color:${COLORS.dark};">${escapeHtml(envelope.signOff)}</p>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>"
  ].join("\n");

  return { html, inlineAssets: brand.assets };
}
