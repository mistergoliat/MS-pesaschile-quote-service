import type { IssuedQuoteDocumentViewModel } from "../../application/quote/documents/issued-quote-document";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCustomerBlock(model: IssuedQuoteDocumentViewModel): string {
  const customerLines = [
    model.customer.businessName,
    model.customer.name,
    model.customer.email,
    model.customer.phone,
    [model.customer.address, model.customer.district, model.customer.region]
      .filter((value) => value && value.length > 0)
      .join(", ")
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return customerLines
    .map((value) => `<div style="margin:0 0 4px 0;">${escapeHtml(value)}</div>`)
    .join("");
}

function renderItemRows(model: IssuedQuoteDocumentViewModel): string {
  return model.items
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #d5d8de;">
            <div style="font-weight:600;color:#0f172a;">${escapeHtml(item.description)}</div>
            <div style="font-size:12px;color:#64748b;">${escapeHtml(item.typeLabel)}${
              item.sku ? ` · SKU ${escapeHtml(item.sku)}` : ""
            }</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #d5d8de;text-align:right;">${escapeHtml(item.quantityDisplay)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #d5d8de;text-align:right;">${escapeHtml(item.unitPriceDisplay)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #d5d8de;text-align:right;">${escapeHtml(item.lineTotalDisplay)}</td>
        </tr>
      `
    )
    .join("");
}

export function renderQuoteEmailHtml(model: IssuedQuoteDocumentViewModel): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cotización ${escapeHtml(model.quoteNumber)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" style="width:100%;border-collapse:collapse;">
      <tr>
        <td align="center">
          <table role="presentation" style="width:100%;max-width:720px;border-collapse:collapse;background:#ffffff;border:1px solid #d5d8de;">
            <tr>
              <td style="padding:28px 32px;background:#0f172a;color:#ffffff;">
                <div style="font-size:24px;font-weight:700;letter-spacing:0.02em;">${escapeHtml(model.companyName)}</div>
                <div style="margin-top:8px;font-size:14px;opacity:0.85;">Cotización ${escapeHtml(model.quoteNumber)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;">
                <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:24px;">
                  <tr>
                    <td style="width:50%;vertical-align:top;padding-right:12px;">
                      <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;margin-bottom:8px;">Cliente</div>
                      ${renderCustomerBlock(model)}
                    </td>
                    <td style="width:50%;vertical-align:top;padding-left:12px;">
                      <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;margin-bottom:8px;">Resumen</div>
                      <div style="margin-bottom:4px;">Emitida: ${escapeHtml(model.issuedAtDisplay)}</div>
                      <div style="margin-bottom:4px;">Válida hasta: ${escapeHtml(model.validUntilDisplay)}</div>
                      <div>Versión documental: ${escapeHtml(model.renderVersion)}</div>
                    </td>
                  </tr>
                </table>
                <table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid #d5d8de;">
                  <thead>
                    <tr style="background:#e2e8f0;color:#0f172a;">
                      <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;">Detalle</th>
                      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;">Cant.</th>
                      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;">Precio unit.</th>
                      <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${renderItemRows(model)}
                  </tbody>
                </table>
                <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:20px;">
                  <tr>
                    <td></td>
                    <td style="width:260px;">
                      <table role="presentation" style="width:100%;border-collapse:collapse;">
                        <tr>
                          <td style="padding:6px 0;color:#475569;">Subtotal</td>
                          <td style="padding:6px 0;text-align:right;">${escapeHtml(model.pricing.subtotalDisplay)}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;color:#475569;">IVA</td>
                          <td style="padding:6px 0;text-align:right;">${escapeHtml(model.pricing.taxAmountDisplay)}</td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;font-size:18px;font-weight:700;color:#0f172a;">Total</td>
                          <td style="padding:8px 0;text-align:right;font-size:18px;font-weight:700;color:#0f172a;">${escapeHtml(model.pricing.totalDisplay)}</td>
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
    </table>
  </body>
</html>`;
}

export function renderQuotePrintableHtml(model: IssuedQuoteDocumentViewModel): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Cotización ${escapeHtml(model.quoteNumber)}</title>
    <style>
      @page {
        size: A4;
        margin: 18mm;
      }
      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        color: #0f172a;
      }
      .page {
        width: 100%;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 24px;
      }
      .brand {
        font-size: 24px;
        font-weight: 700;
      }
      .muted {
        color: #475569;
      }
      .section-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #475569;
        margin-bottom: 8px;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
        margin-bottom: 24px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        border-bottom: 1px solid #cbd5e1;
        padding: 10px 8px;
        vertical-align: top;
      }
      th {
        font-size: 12px;
        text-transform: uppercase;
        color: #334155;
        text-align: left;
        background: #e2e8f0;
      }
      .numeric {
        text-align: right;
        white-space: nowrap;
      }
      .totals {
        margin-top: 20px;
        width: 280px;
        margin-left: auto;
      }
      .totals td {
        padding: 6px 0;
        border-bottom: 0;
      }
      .grand-total td {
        padding-top: 10px;
        font-weight: 700;
        font-size: 18px;
      }
      .footer {
        margin-top: 24px;
        font-size: 12px;
        color: #64748b;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          <div class="brand">${escapeHtml(model.companyName)}</div>
          <div class="muted">Cotización comercial</div>
        </div>
        <div>
          <div><strong>${escapeHtml(model.quoteNumber)}</strong></div>
          <div class="muted">Emitida: ${escapeHtml(model.issuedAtDisplay)}</div>
          <div class="muted">Vigencia: ${escapeHtml(model.validUntilDisplay)}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div>
          <div class="section-title">Cliente</div>
          ${renderCustomerBlock(model)}
        </div>
        <div>
          <div class="section-title">Documento</div>
          <div>Versión de render: ${escapeHtml(model.renderVersion)}</div>
          <div>Moneda: ${escapeHtml(model.currency)}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Detalle</th>
            <th class="numeric">Cant.</th>
            <th class="numeric">Precio unit.</th>
            <th class="numeric">Subtotal</th>
            <th class="numeric">IVA</th>
            <th class="numeric">Total</th>
          </tr>
        </thead>
        <tbody>
          ${model.items
            .map(
              (item) => `
                <tr>
                  <td>
                    <div style="font-weight:600;">${escapeHtml(item.description)}</div>
                    <div class="muted" style="font-size:12px;">${escapeHtml(item.typeLabel)}${
                      item.sku ? ` · SKU ${escapeHtml(item.sku)}` : ""
                    }</div>
                  </td>
                  <td class="numeric">${escapeHtml(item.quantityDisplay)}</td>
                  <td class="numeric">${escapeHtml(item.unitPriceDisplay)}</td>
                  <td class="numeric">${escapeHtml(item.lineSubtotalDisplay)}</td>
                  <td class="numeric">${escapeHtml(item.lineTaxDisplay)}</td>
                  <td class="numeric">${escapeHtml(item.lineTotalDisplay)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>

      <table class="totals">
        <tr>
          <td class="muted">Subtotal</td>
          <td class="numeric">${escapeHtml(model.pricing.subtotalDisplay)}</td>
        </tr>
        <tr>
          <td class="muted">IVA</td>
          <td class="numeric">${escapeHtml(model.pricing.taxAmountDisplay)}</td>
        </tr>
        <tr class="grand-total">
          <td>Total</td>
          <td class="numeric">${escapeHtml(model.pricing.totalDisplay)}</td>
        </tr>
      </table>

      <div class="footer">
        Documento generado por ${escapeHtml(model.companyName)} para la cotización ${escapeHtml(model.quoteNumber)}.
      </div>
    </div>
  </body>
</html>`;
}
