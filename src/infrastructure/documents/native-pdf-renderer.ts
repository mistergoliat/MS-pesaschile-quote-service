import { createRequire } from "node:module";

import type { DependencyReadinessStatus } from "../../application/health/readiness-service";
import {
  buildIssuedQuoteDocumentViewModel,
  type CanonicalIssuedQuoteSnapshot,
  type IssuedQuoteDocumentViewModel
} from "../../application/quote/documents/issued-quote-document";
import type { BrandTheme, SenderSignature } from "../branding/brand-theme";
import { resolveBrandAsset } from "../branding/brand-asset-resolver";

const pdfMakeRequire = createRequire(__filename);

interface PdfDocumentDefinition {
  readonly content: readonly unknown[];
  readonly defaultStyle?: Record<string, unknown>;
  readonly styles?: Record<string, Record<string, unknown>>;
  readonly images?: Record<string, string>;
  readonly pageSize?: string;
  readonly pageMargins?: readonly number[];
  readonly header?: unknown;
  readonly footer?: unknown;
  readonly info?: Record<string, unknown>;
}

interface PdfKitDocument extends NodeJS.ReadableStream {
  end(): void;
}

interface PdfPrinter {
  createPdfKitDocument(definition: PdfDocumentDefinition): PdfKitDocument;
}

interface PdfPrinterConstructor {
  new (fonts: Record<string, Record<string, string>>): PdfPrinter;
}

const PdfPrinter = pdfMakeRequire("pdfmake/src/printer") as PdfPrinterConstructor;

export interface PdfRendererPort {
  renderPdf(snapshot: CanonicalIssuedQuoteSnapshot): Promise<Buffer>;
  checkReadiness(): Promise<DependencyReadinessStatus>;
}

export interface NativePdfRendererConfig {
  readonly renderVersion: string;
  readonly brand: BrandTheme;
  readonly senderSignature: SenderSignature;
}

const COLORS = {
  raspberry: "#E62158",
  gunmetal: "#1D2B35",
  antiFlashWhite: "#ECF0F1",
  muted: "#5B6C75",
  border: "#D8E0E2"
} as const;

// POPPINS_ASSET_PENDING: no approved Poppins font files are versioned in this repository.
const FONTS = {
  Helvetica: {
    normal: "Helvetica",
    bold: "Helvetica-Bold",
    italics: "Helvetica-Oblique",
    bolditalics: "Helvetica-BoldOblique"
  }
} as const;

function toDataUri(asset: { readonly mediaType: string; readonly content: Buffer }): string {
  return `data:${asset.mediaType};base64,${asset.content.toString("base64")}`;
}

function buildLineMetadata(item: IssuedQuoteDocumentViewModel["items"][number]): string {
  return item.sku ? `${item.typeLabel} · SKU ${item.sku}` : item.typeLabel;
}

export class NativePdfRenderer implements PdfRendererPort {
  constructor(private readonly config: NativePdfRendererConfig) {}

  async renderPdf(snapshot: CanonicalIssuedQuoteSnapshot): Promise<Buffer> {
    const model = buildIssuedQuoteDocumentViewModel({
      snapshot,
      renderVersion: this.config.renderVersion,
      companyName: this.config.brand.company.legalName
    });
    const definition = this.buildDefinition(model);
    const document = new PdfPrinter(FONTS).createPdfKitDocument(definition);

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      document.on("data", (chunk: unknown) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      });
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
      document.end();
    });
  }

  checkReadiness(): Promise<DependencyReadinessStatus> {
    return Promise.resolve({ status: "up" });
  }

  private buildDefinition(model: IssuedQuoteDocumentViewModel): PdfDocumentDefinition {
    const logoOnLight = resolveBrandAsset(this.config.brand.assets.logoOnLight);
    const content: unknown[] = [
      {
        columns: [
          logoOnLight
            ? {
                image: "logoOnLight",
                width: 190,
                margin: [0, 0, 18, 0]
              }
            : { text: model.companyName, style: "brandFallback" },
          {
            stack: [
              { text: "COTIZACIÓN", style: "documentLabel", alignment: "right" },
              { text: model.quoteNumber, style: "quoteNumber", alignment: "right" },
              { text: `Emitida: ${model.issuedAtDisplay}`, style: "mutedSmall", alignment: "right" },
              { text: `Vigencia: ${model.validUntilDisplay}`, style: "mutedSmall", alignment: "right" }
            ],
            width: "*"
          }
        ],
        columnGap: 18,
        margin: [0, 0, 0, 22]
      },
      {
        table: {
          widths: ["*", "*"] as const,
          body: [
            [
              {
                stack: [
                  { text: "DATOS DEL CLIENTE", style: "sectionLabel" },
                  ...this.customerLines(model)
                ],
                margin: [0, 0, 12, 0]
              },
              {
                stack: [
                  { text: "DOCUMENTO", style: "sectionLabel" },
                  { text: `N° cotización: ${model.quoteNumber}`, style: "body" },
                  { text: `Fecha emisión: ${model.issuedAtDisplay}`, style: "body" },
                  { text: `Vigencia: ${model.validUntilDisplay}`, style: "body" },
                  { text: `Moneda: ${model.currency}`, style: "body" },
                  { text: model.pricing.pricingNote, style: "body" }
                ],
                margin: [12, 0, 0, 0]
              }
            ]
          ]
        },
        layout: "noBorders",
        margin: [0, 0, 0, 20]
      },
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          keepWithHeaderRows: 1,
          widths: ["*", 42, 82, 82] as const,
          body: [
            [
              { text: "DESCRIPCIÓN", style: "tableHeader" },
              { text: "CANT.", style: "tableHeader", alignment: "right" },
              { text: "PRECIO UNITARIO", style: "tableHeader", alignment: "right" },
              { text: "TOTAL", style: "tableHeader", alignment: "right" }
            ],
            ...model.items.map((item) => [
              {
                stack: [
                  { text: item.description, style: "bodyStrong" },
                  { text: buildLineMetadata(item), style: "mutedSmall" }
                ],
                margin: [0, 2, 0, 2]
              },
              { text: item.quantityDisplay, style: "body", alignment: "right" },
              { text: item.unitPriceDisplay, style: "body", alignment: "right" },
              { text: item.lineTotalDisplay, style: "body", alignment: "right" }
            ])
          ]
        },
        layout: {
          fillColor: (rowIndex: number) => (rowIndex === 0 ? COLORS.antiFlashWhite : null),
          hLineColor: () => COLORS.border,
          vLineColor: () => COLORS.border,
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 7,
          paddingBottom: () => 7
        },
        margin: [0, 0, 0, 18]
      },
      {
        columns: [
          {
            stack: [
              { text: "CONDICIONES COMERCIALES", style: "sectionLabel" },
              { text: model.pricing.pricingNote, style: "body" },
              { text: `Oferta válida hasta ${model.validUntilDisplay}.`, style: "body" }
            ],
            width: "*"
          },
          {
            table: {
              widths: ["*", 90] as const,
              body: [
                [
                  { text: "Neto", style: "mutedSmall" },
                  { text: model.pricing.subtotalDisplay, style: "body", alignment: "right" }
                ],
                [
                  { text: "IVA", style: "mutedSmall" },
                  { text: model.pricing.taxAmountDisplay, style: "body", alignment: "right" }
                ],
                [
                  { text: "TOTAL", style: "totalLabel" },
                  { text: model.pricing.totalDisplay, style: "totalValue", alignment: "right" }
                ]
              ]
            },
            layout: "noBorders",
            width: 220
          }
        ],
        columnGap: 24,
        margin: [0, 0, 0, 24]
      },
      {
        stack: [
          { text: this.config.senderSignature.name, style: "bodyStrong" },
          { text: this.config.senderSignature.role, style: "signatureRole" },
          ...[
            this.config.senderSignature.website,
            this.config.senderSignature.email,
            this.config.senderSignature.phone,
            this.config.senderSignature.address
          ]
            .filter((value): value is string => Boolean(value))
            .map((value) => ({ text: value, style: "mutedSmall" }))
        ],
        margin: [0, 0, 0, 8]
      }
    ];

    return {
      pageSize: "A4",
      pageMargins: [48, 48, 48, 44],
      content,
      ...(logoOnLight ? { images: { logoOnLight: toDataUri(logoOnLight) } } : {}),
      defaultStyle: {
        font: "Helvetica",
        fontSize: 9,
        color: COLORS.gunmetal
      },
      styles: {
        brandFallback: { fontSize: 22, bold: true, color: COLORS.gunmetal },
        documentLabel: { fontSize: 8, bold: true, color: COLORS.raspberry, characterSpacing: 1.2 },
        quoteNumber: { fontSize: 18, bold: true, color: COLORS.gunmetal, margin: [0, 2, 0, 4] },
        sectionLabel: {
          fontSize: 8,
          bold: true,
          color: COLORS.muted,
          characterSpacing: 1.1,
          margin: [0, 0, 0, 6]
        },
        body: { fontSize: 9, color: COLORS.gunmetal },
        bodyStrong: { fontSize: 9, bold: true, color: COLORS.gunmetal },
        mutedSmall: { fontSize: 8, color: COLORS.muted },
        tableHeader: { fontSize: 7.5, bold: true, color: COLORS.gunmetal },
        totalLabel: { fontSize: 10, bold: true, color: COLORS.gunmetal },
        totalValue: { fontSize: 14, bold: true, color: COLORS.raspberry },
        signatureRole: { fontSize: 9, bold: true, color: COLORS.raspberry, margin: [0, 2, 0, 2] }
      },
      header: () => ({
        canvas: [{ type: "rect", x: 0, y: 0, w: 595, h: 4, color: COLORS.raspberry }]
      }),
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          {
            text: [
              this.config.brand.company.legalName,
              this.config.brand.company.website,
              model.quoteNumber
            ]
              .filter((value): value is string => Boolean(value))
              .join(" · "),
            style: "mutedSmall"
          },
          { text: `Página ${currentPage} de ${pageCount}`, style: "mutedSmall", alignment: "right" }
        ],
        margin: [48, 8, 48, 0]
      }),
      info: {
        title: `Cotización ${model.quoteNumber}`,
        author: this.config.brand.company.legalName,
        subject: "Cotización comercial",
        creator: "PesasChile Quote Service",
        producer: "pdfmake",
        creationDate: new Date(model.issuedAt)
      }
    };
  }

  private customerLines(model: IssuedQuoteDocumentViewModel): Array<Record<string, unknown>> {
    return [
      model.customer.businessName,
      model.customer.name,
      model.customer.email,
      model.customer.phone,
      [model.customer.address, model.customer.district, model.customer.region]
        .filter((value): value is string => Boolean(value))
        .join(", ")
    ]
      .filter((value): value is string => Boolean(value))
      .map((value, index) => ({
        text: value,
        style: index === 0 ? "bodyStrong" : "body",
        margin: [0, 0, 0, 3]
      }));
  }
}
