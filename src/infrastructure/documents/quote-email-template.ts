import { resolveBrandAsset } from "../branding/brand-asset-resolver";
import {
  QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
  QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID
} from "./quote-email-inline-assets";
import type { QuoteEmailViewModel } from "./quote-email-view-model";
import { escapeHtml, sanitizeHref } from "./html-escaping";

type BrandLogoSurface = "light" | "dark";

function renderBrandLogo(
  model: QuoteEmailViewModel,
  surface: BrandLogoSurface,
  width: number
): string {
  const resolvedDarkLogo = resolveBrandAsset(model.brand.assets.logoDark);
  const resolvedLightLogo = resolveBrandAsset(model.brand.assets.logoLight);

  if (!resolvedDarkLogo || !resolvedLightLogo) {
    return [
      '<div style="font-family:',
      escapeHtml(model.brand.typography.fallback),
      ";font-size:28px;line-height:32px;font-weight:800;color:",
      surface === "dark" ? model.brand.colors.light : model.brand.colors.dark,
      ';">Pesas Chile</div>'
    ].join("");
  }

  return [
    `<div class="quote-email__brand-logo quote-email__brand-logo--surface-${surface}" style="display:block;">`,
    `<img class="quote-email__brand-logo-dark" src="cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}"`,
    ' alt="Pesas Chile"',
    ` width="${width}"`,
    ` style="display:${surface === "dark" ? "block" : "none"};width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${surface === "light" ? "max-height:0;overflow:hidden;mso-hide:all;" : ""}" />`,
    `<img class="quote-email__brand-logo-light" src="cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}"`,
    ' alt="Pesas Chile"',
    ` width="${width}"`,
    ` style="display:${surface === "light" ? "block" : "none"};width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${surface === "dark" ? "max-height:0;overflow:hidden;mso-hide:all;" : ""}" />`,
    "</div>"
  ].join("");
}

function renderEmailStyleBlock(model: QuoteEmailViewModel): string {
  return `<style>
    .quote-email__header-surface {
      background:#F7F9FA !important;
      color:${model.brand.colors.dark} !important;
    }
    .quote-email__surface-dark {
      background:${model.brand.colors.dark} !important;
      color:${model.brand.colors.light} !important;
    }
    .quote-email__surface-light {
      background:#F7F9FA !important;
      color:${model.brand.colors.dark} !important;
    }
    .quote-email__header-label {
      color:#6B7B85 !important;
    }
    .quote-email__header-number,
    .quote-email__header-issued {
      color:${model.brand.colors.dark} !important;
    }
    .quote-email__signature-name {
      color:${model.brand.colors.dark} !important;
    }
    .quote-email__signature-role {
      color:${model.brand.colors.primary} !important;
    }
    .quote-email__signature-label {
      color:#5B6C75 !important;
    }
    .quote-email__signature-value,
    .quote-email__signature-value a {
      color:${model.brand.colors.dark} !important;
    }
    .quote-email__footer-meta {
      color:#6B7B85 !important;
    }
    .quote-email__brand-logo--surface-light .quote-email__brand-logo-dark {
      display:none !important;
      max-height:0 !important;
      overflow:hidden !important;
      mso-hide:all !important;
    }
    .quote-email__brand-logo--surface-light .quote-email__brand-logo-light {
      display:block !important;
      max-height:none !important;
      overflow:visible !important;
      mso-hide:none !important;
    }
    .quote-email__brand-logo--surface-dark .quote-email__brand-logo-dark {
      display:block !important;
      max-height:none !important;
      overflow:visible !important;
      mso-hide:none !important;
    }
    .quote-email__brand-logo--surface-dark .quote-email__brand-logo-light {
      display:none !important;
      max-height:0 !important;
      overflow:hidden !important;
      mso-hide:all !important;
    }
    @media (prefers-color-scheme: dark) {
      .quote-email__header-surface {
        background:${model.brand.colors.dark} !important;
        color:${model.brand.colors.light} !important;
      }
      .quote-email__header-label {
        color:#A5BAB7 !important;
      }
      .quote-email__header-number,
      .quote-email__header-issued {
        color:${model.brand.colors.light} !important;
      }
      .quote-email__surface-dark {
        background:${model.brand.colors.dark} !important;
        color:${model.brand.colors.light} !important;
      }
      .quote-email__surface-light {
        background:#F7F9FA !important;
        color:${model.brand.colors.dark} !important;
      }
      .quote-email__brand-logo-light {
        display:none !important;
        max-height:0 !important;
        overflow:hidden !important;
        mso-hide:all !important;
      }
      .quote-email__brand-logo-dark {
        display:block !important;
        max-height:none !important;
        overflow:visible !important;
        mso-hide:none !important;
      }
      .quote-email__brand-logo--surface-light .quote-email__brand-logo-dark {
        display:block !important;
        max-height:none !important;
        overflow:visible !important;
        mso-hide:none !important;
      }
      .quote-email__brand-logo--surface-light .quote-email__brand-logo-light {
        display:none !important;
        max-height:0 !important;
        overflow:hidden !important;
        mso-hide:all !important;
      }
    }
    html[data-force-color-scheme="dark"] .quote-email__header-surface {
      background:${model.brand.colors.dark} !important;
      color:${model.brand.colors.light} !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__header-label {
      color:#A5BAB7 !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__header-number,
    html[data-force-color-scheme="dark"] .quote-email__header-issued {
      color:${model.brand.colors.light} !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__surface-dark {
      background:${model.brand.colors.dark} !important;
      color:${model.brand.colors.light} !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__surface-light {
      background:#F7F9FA !important;
      color:${model.brand.colors.dark} !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__brand-logo-light {
      display:none !important;
      max-height:0 !important;
      overflow:hidden !important;
      mso-hide:all !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__brand-logo-dark {
      display:block !important;
      max-height:none !important;
      overflow:visible !important;
      mso-hide:none !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__brand-logo--surface-light .quote-email__brand-logo-dark {
      display:block !important;
      max-height:none !important;
      overflow:visible !important;
      mso-hide:none !important;
    }
    html[data-force-color-scheme="dark"] .quote-email__brand-logo--surface-light .quote-email__brand-logo-light {
      display:none !important;
      max-height:0 !important;
      overflow:hidden !important;
      mso-hide:all !important;
    }
  </style>`;
}

function renderCustomerRow(label: string, value: string | null): string {
  if (!value) {
    return "";
  }

  return [
    "<tr>",
    '<td style="padding:0 0 10px 0;font-size:13px;line-height:20px;color:#1D2B35;">',
    `<strong style="display:block;font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:#6B7B85;">${escapeHtml(label)}</strong>`,
    `<span>${escapeHtml(value)}</span>`,
    "</td>",
    "</tr>"
  ].join("");
}

function renderItemRows(model: QuoteEmailViewModel): string {
  return model.items
    .map((item) => {
      const detail = `${item.typeLabel}${item.sku ? ` - SKU ${item.sku}` : ""}`;

      return [
        "<tr>",
        '<td style="padding:14px 16px;border-bottom:1px solid #D8E0E2;font-size:14px;line-height:20px;color:#1D2B35;">',
        `<strong style="display:block;font-size:14px;color:#1D2B35;">${escapeHtml(item.description)}</strong>`,
        `<span style="display:block;font-size:12px;color:#5B6C75;">${escapeHtml(detail)}</span>`,
        "</td>",
        `<td style="padding:14px 12px;border-bottom:1px solid #D8E0E2;font-size:14px;line-height:20px;color:#1D2B35;text-align:right;white-space:nowrap;">${escapeHtml(item.quantity)}</td>`,
        `<td style="padding:14px 12px;border-bottom:1px solid #D8E0E2;font-size:14px;line-height:20px;color:#1D2B35;text-align:right;white-space:nowrap;">${escapeHtml(item.unitPriceFormatted)}</td>`,
        `<td style="padding:14px 16px;border-bottom:1px solid #D8E0E2;font-size:14px;line-height:20px;color:#1D2B35;text-align:right;white-space:nowrap;">${escapeHtml(item.lineTotalFormatted)}</td>`,
        "</tr>"
      ].join("");
    })
    .join("");
}

function renderContactValue(label: string, value: string | null, href: string | null): string {
  if (!value) {
    return "";
  }

  return [
    "<tr>",
    '<td class="quote-email__signature-value" style="padding:0 0 8px 0;font-size:13px;line-height:20px;color:#1D2B35;">',
    `<strong class="quote-email__signature-label" style="color:#5B6C75;">${escapeHtml(label)}:</strong> `,
    href
      ? `<a href="${escapeHtml(href)}" style="color:#1D2B35;text-decoration:none;">${escapeHtml(value)}</a>`
      : escapeHtml(value),
    "</td>",
    "</tr>"
  ].join("");
}

function renderSocialLinks(model: QuoteEmailViewModel): string {
  const socialLinks = model.senderSignature.socialLinks;

  if (!socialLinks) {
    return "";
  }

  const socialEntries: Array<readonly [string, string | undefined]> = [
    ["Facebook", socialLinks.facebook],
    ["Instagram", socialLinks.instagram],
    ["YouTube", socialLinks.youtube],
    ["TikTok", socialLinks.tiktok],
    ["LinkedIn", socialLinks.linkedin]
  ];
  const socialItems = socialEntries
    .map(([label, url]) => {
      if (!url) {
        return "";
      }

      const safeHref = sanitizeHref(url, ["https:", "http:"]);

      if (!safeHref) {
        return "";
      }

      return `<a href="${escapeHtml(safeHref)}" style="display:inline-block;padding:6px 10px;margin:0 6px 6px 0;border:1px solid #B7C3C8;border-radius:999px;font-size:11px;line-height:14px;color:#1D2B35;text-decoration:none;">${escapeHtml(label)}</a>`;
    })
    .filter((value) => value.length > 0)
    .join("");

  if (socialItems.length === 0) {
    return "";
  }

  return `<tr><td style="padding:10px 0 0 0;">${socialItems}</td></tr>`;
}

export function renderQuoteEmailHtml(model: QuoteEmailViewModel): string {
  const typography = escapeHtml(model.brand.typography.fallback);
  const websiteHref = model.senderSignature.website
    ? sanitizeHref(model.senderSignature.website, ["https:", "http:"])
    : null;
  const emailHref = model.senderSignature.email
    ? sanitizeHref(model.senderSignature.email, ["mailto:"])
    : null;
  const phoneHref = model.senderSignature.phone
    ? sanitizeHref(model.senderSignature.phone, ["tel:"])
    : null;

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <meta name="x-brand-version" content="${escapeHtml(model.brandVersion)}" />
    <meta name="x-email-template-version" content="${escapeHtml(model.emailTemplateVersion)}" />
    ${renderEmailStyleBlock(model)}
    <title>Cotizaci&oacute;n ${escapeHtml(model.quote.quoteNumber)}</title>
  </head>
  <body style="margin:0;padding:0;background:${model.brand.colors.light};font-family:${typography};">
    <!-- brandVersion=${escapeHtml(model.brandVersion)} emailTemplateVersion=${escapeHtml(model.emailTemplateVersion)} -->
    <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;background:${model.brand.colors.light};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" style="width:100%;max-width:640px;border-collapse:collapse;background:#FFFFFF;">
            <tr>
              <td style="height:6px;line-height:6px;font-size:0;background:${model.brand.colors.primary};">&nbsp;</td>
            </tr>
            <tr>
              <td class="quote-email__header-surface" style="padding:28px 28px 24px 28px;background:#F7F9FA;">
                <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td style="vertical-align:middle;padding:0 12px 16px 0;">${renderBrandLogo(model, "light", 220)}</td>
                    <td align="right" style="vertical-align:middle;padding:0;color:${model.brand.colors.dark};">
                      <div class="quote-email__header-label" style="font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;color:#6B7B85;">Cotizaci&oacute;n</div>
                      <div class="quote-email__header-number" style="font-size:24px;line-height:28px;font-weight:800;color:${model.brand.colors.dark};">${escapeHtml(model.quote.quoteNumber)}</div>
                      <div class="quote-email__header-issued" style="padding-top:8px;font-size:13px;line-height:20px;color:${model.brand.colors.dark};">Emitida: ${escapeHtml(model.quote.issuedAtFormatted)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 20px 28px;background:#FFFFFF;">
                <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td style="padding:0 0 18px 0;font-size:20px;line-height:28px;font-weight:700;color:${model.brand.colors.dark};">
                      Hola ${escapeHtml(model.customer.name)},
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 22px 0;font-size:15px;line-height:24px;color:${model.brand.colors.dark};">
                      Te compartimos tu cotizaci&oacute;n comercial de ${escapeHtml(model.brand.company.displayName)} con el resumen de productos y servicios solicitados.
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 22px 0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;background:#F7F9FA;border:1px solid #D8E0E2;">
                        <tr>
                          <td style="padding:18px 18px 8px 18px;font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#6B7B85;">
                            Datos del cliente
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 18px 8px 18px;">
                            <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                              ${renderCustomerRow("Nombre", model.customer.name)}
                              ${renderCustomerRow("Empresa", model.customer.businessName)}
                              ${renderCustomerRow("Email", model.customer.email)}
                              ${renderCustomerRow("Telefono", model.customer.phone)}
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 10px 0;font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#6B7B85;">
                      Productos y servicios
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 12px 0;font-size:13px;line-height:20px;color:#5B6C75;">
                      ${escapeHtml(model.pricing.pricingNote)}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 22px 0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #D8E0E2;">
                        <thead>
                          <tr style="background:#EEF2F3;">
                            <th style="padding:12px 16px;text-align:left;font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:#5B6C75;">Producto / Servicio</th>
                            <th style="padding:12px;text-align:right;font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:#5B6C75;">Cantidad</th>
                            <th style="padding:12px;text-align:right;font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:#5B6C75;">Precio unitario</th>
                            <th style="padding:12px 16px;text-align:right;font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:#5B6C75;">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${renderItemRows(model)}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 22px 0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                        <tr>
                          <td style="padding:0 0 18px 0;font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#6B7B85;">
                            Resumen comercial
                          </td>
                        </tr>
                        <tr>
                          <td align="right">
                            <table role="presentation" style="width:100%;max-width:320px;border-collapse:collapse;">
                              <tr>
                                <td colspan="2" style="padding:0 0 10px 0;font-size:13px;line-height:20px;color:#5B6C75;text-align:right;">
                                  ${escapeHtml(model.pricing.pricingNote)}
                                </td>
                              </tr>
                              <tr>
                                <td colspan="2" style="padding:0;">
                                  <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;background:#FFF4F7;border:1px solid #F5C3D2;">
                                    <tr>
                                      <td style="padding:14px 16px;font-size:13px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:${model.brand.colors.dark};">Total</td>
                                      <td style="padding:14px 16px;font-size:24px;line-height:28px;font-weight:800;color:${model.brand.colors.primary};text-align:right;white-space:nowrap;">${escapeHtml(model.pricing.totalFormatted)}</td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 22px 0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;background:#F7F9FA;border-left:4px solid ${model.brand.colors.primary};">
                        <tr>
                          <td style="padding:18px 18px 16px 18px;font-size:16px;line-height:24px;font-weight:700;color:${model.brand.colors.dark};">
                            Vigencia de la oferta
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 18px 10px 18px;font-size:14px;line-height:22px;color:${model.brand.colors.dark};">
                            ${escapeHtml(model.validity.policyText)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 18px 18px 18px;font-size:14px;line-height:22px;color:${model.brand.colors.dark};">
                            <strong>Valida hasta:</strong> ${escapeHtml(model.validity.validUntilFormatted)}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 24px 0;font-size:14px;line-height:22px;color:${model.brand.colors.dark};">
                      Adjuntamos el PDF formal de tu cotizaci&oacute;n con el detalle completo y terminos de la oferta.
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;border:1px solid #D8E0E2;">
                        <tr>
                          <td class="quote-email__surface-dark" style="width:188px;padding:22px;background:${model.brand.colors.dark};vertical-align:top;">
                            ${renderBrandLogo(model, "dark", 156)}
                            <div style="padding-top:18px;">
                              <div style="height:4px;width:72px;background:${model.brand.colors.primary};font-size:0;line-height:0;">&nbsp;</div>
                            </div>
                          </td>
                          <td class="quote-email__surface-light" style="padding:20px 22px;background:#F7F9FA;vertical-align:top;">
                            <div class="quote-email__signature-name" style="padding:0 0 8px 0;font-size:24px;line-height:28px;font-weight:800;color:${model.brand.colors.dark};">
                              ${escapeHtml(model.senderSignature.name)}
                            </div>
                            <div class="quote-email__signature-role" style="padding:0 0 14px 0;font-size:14px;line-height:20px;font-weight:700;color:${model.brand.colors.primary};">
                              ${escapeHtml(model.senderSignature.role)}
                            </div>
                            <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                              ${renderContactValue("Sitio web", model.senderSignature.website, websiteHref)}
                              ${renderContactValue("Email", model.senderSignature.email, emailHref)}
                              ${renderContactValue("Telefono", model.senderSignature.phone, phoneHref)}
                              ${renderContactValue("Direccion", model.senderSignature.address, null)}
                              ${renderSocialLinks(model)}
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:18px 0 0 0;text-align:center;">
                      <div class="quote-email__footer-meta" style="font-size:12px;line-height:18px;color:#6B7B85;">
                        ${escapeHtml(model.brand.company.legalName)}${model.brand.company.website ? ` &middot; ${escapeHtml(model.brand.company.website)}` : ""} &middot; ${escapeHtml(model.quote.currency)}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
