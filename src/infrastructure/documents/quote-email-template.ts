import { resolveBrandAsset } from "../branding/brand-asset-resolver";
import type { QuoteEmailViewModel } from "./quote-email-view-model";
import { escapeHtml, sanitizeHref } from "./html-escaping";

function renderBrandSymbol(model: QuoteEmailViewModel): string {
  const resolved = resolveBrandAsset(model.brand.assets.symbol);

  if (!resolved) {
    return [
      '<div style="width:44px;height:44px;border-radius:12px;background:',
      model.brand.colors.primary,
      ";color:",
      model.brand.colors.light,
      ";font-family:",
      escapeHtml(model.brand.typography.fallback),
      ';font-size:18px;font-weight:700;line-height:44px;text-align:center;">PC</div>'
    ].join("");
  }

  return resolved.content;
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
      const detail = `${item.typeLabel}${item.sku ? ` · SKU ${item.sku}` : ""}`;

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
    '<td style="padding:0 0 8px 0;font-size:13px;line-height:20px;color:#ECF0F1;">',
    `<strong style="color:#A5BAB7;">${escapeHtml(label)}:</strong> `,
    href
      ? `<a href="${escapeHtml(href)}" style="color:#ECF0F1;text-decoration:none;">${escapeHtml(value)}</a>`
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

      return `<a href="${escapeHtml(safeHref)}" style="display:inline-block;padding:6px 10px;margin:0 6px 6px 0;border:1px solid #51636E;border-radius:999px;font-size:11px;line-height:14px;color:#ECF0F1;text-decoration:none;">${escapeHtml(label)}</a>`;
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
    <meta name="x-brand-version" content="${escapeHtml(model.brandVersion)}" />
    <meta name="x-email-template-version" content="${escapeHtml(model.emailTemplateVersion)}" />
    <title>Cotizacion ${escapeHtml(model.quote.quoteNumber)}</title>
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
              <td style="padding:28px 28px 24px 28px;background:${model.brand.colors.dark};">
                <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td style="vertical-align:top;padding:0 12px 16px 0;">
                      <table role="presentation" style="border-collapse:collapse;">
                        <tr>
                          <td style="vertical-align:middle;padding:0 14px 0 0;">${renderBrandSymbol(model)}</td>
                          <td style="vertical-align:middle;">
                            <div style="font-family:${typography};font-size:28px;line-height:30px;font-weight:800;color:${model.brand.colors.light};">${escapeHtml(model.brand.company.displayName)}</div>
                            <div style="font-family:${typography};font-size:12px;line-height:18px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${model.brand.colors.primary};">Quote Service V1</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td align="right" style="vertical-align:top;padding:0;color:${model.brand.colors.light};">
                      <div style="font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;color:#A5BAB7;">Cotizacion</div>
                      <div style="font-size:24px;line-height:28px;font-weight:800;color:${model.brand.colors.light};">${escapeHtml(model.quote.quoteNumber)}</div>
                      <div style="padding-top:8px;font-size:13px;line-height:20px;color:${model.brand.colors.light};">Emitida: ${escapeHtml(model.quote.issuedAtFormatted)}</div>
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
                      Te compartimos tu cotizacion comercial de ${escapeHtml(model.brand.company.displayName)} con el resumen de productos y servicios solicitados.
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
                    <td style="padding:0 0 12px 0;font-size:12px;line-height:18px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#6B7B85;">
                      Productos y servicios
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
                            <table role="presentation" style="width:100%;max-width:300px;border-collapse:collapse;">
                              <tr>
                                <td style="padding:6px 0;font-size:14px;line-height:20px;color:#5B6C75;">Subtotal</td>
                                <td style="padding:6px 0;font-size:14px;line-height:20px;color:${model.brand.colors.dark};text-align:right;">${escapeHtml(model.pricing.subtotalFormatted)}</td>
                              </tr>
                              <tr>
                                <td style="padding:6px 0;font-size:14px;line-height:20px;color:#5B6C75;">IVA</td>
                                <td style="padding:6px 0;font-size:14px;line-height:20px;color:${model.brand.colors.dark};text-align:right;">${escapeHtml(model.pricing.taxFormatted)}</td>
                              </tr>
                              <tr>
                                <td colspan="2" style="padding:8px 0 0 0;">
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
                      Adjuntamos el PDF formal de tu cotizacion con el detalle completo y terminos de la oferta.
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;background:${model.brand.colors.dark};">
                        <tr>
                          <td style="padding:22px 22px 0 22px;">
                            <div style="height:4px;width:72px;background:${model.brand.colors.primary};font-size:0;line-height:0;">&nbsp;</div>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:18px 22px 8px 22px;font-size:24px;line-height:28px;font-weight:800;color:${model.brand.colors.light};">
                            ${escapeHtml(model.senderSignature.name)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 22px 14px 22px;font-size:14px;line-height:20px;font-weight:700;color:${model.brand.colors.primary};">
                            ${escapeHtml(model.senderSignature.role)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:0 22px 22px 22px;">
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
                    <td style="padding:18px 0 0 0;font-size:12px;line-height:18px;color:#6B7B85;text-align:center;">
                      ${escapeHtml(model.brand.company.legalName)}${model.brand.company.website ? ` · ${escapeHtml(model.brand.company.website)}` : ""} · ${escapeHtml(model.quote.currency)}
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
