import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PROBE_OK, probeFailed, type ProbeOutcome } from "../../application/health/dependency-state";
import type { IssuedQuoteDocumentModelV2 } from "../../application/quote-v2/document/issued-quote-document-model";
import { DocumentRenderError, type PdfRendererPort } from "../../application/quote-v2/document/pdf-renderer-port";
import { TEMPLATE_V4 } from "../../application/quote-v2/document/template-v4";
import { RENDERER_PROFILE, RENDERER_VERSION, rendererRuntimeMismatches } from "./renderer-profile";

/*
 * Formal quote PDF renderer (R1.5B2): IssuedQuoteDocumentModelV2 → PDF bytes
 * with pdfmake (in-process, no browser, no network).
 *
 * - Assets (fonts, logo) are read once at construction from module-relative
 *   paths and checked against pinned SHA-256 values; a missing or different
 *   asset, or a running stack that differs from RENDERER_PROFILE, makes the
 *   renderer unavailable (probe → renderer_unavailable), never a silent
 *   fallback.
 * - Every character of the document must have a glyph in every face of the
 *   pinned font set, or rendering fails with `unsupported_glyph` before any
 *   layout: text is never stripped, replaced or drawn as .notdef.
 * - Model values only ever become `text` values. Resource-bearing pdfmake
 *   properties (image, svg, link, font, attachments) are template constants.
 * - Metadata is a function of the model: CreationDate = issuedAt, no
 *   ModDate, no random identifier, so the same model gives the same bytes.
 */

interface PdfKitDocument extends NodeJS.ReadableStream {
  end(): void;
}

interface PdfPrinter {
  createPdfKitDocument(definition: Record<string, unknown>): PdfKitDocument;
}

type PdfPrinterConstructor = new (fonts: Record<string, Record<string, Buffer>>) => PdfPrinter;

interface FontkitFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

const runtimeRequire = createRequire(__filename);
const PdfPrinter = runtimeRequire("pdfmake/src/printer") as PdfPrinterConstructor;
// The fontkit instance pdfkit itself embeds fonts with (same resolution path).
const fontkit = createRequire(runtimeRequire.resolve("@foliojs-fork/pdfkit"))("@foliojs-fork/fontkit") as {
  create(buffer: Buffer): FontkitFont;
};

const FONT_FAMILY = "QuoteSans";
const LOGO_IMAGE_KEY = "issuerLogo";

/** Code-controlled images: the only images a document can reference. */
const IMAGE_ASSETS: Readonly<Record<string, { readonly file: string; readonly sha256: string }>> = {
  "asset://pesaschile-brand-v1/logo-on-light": {
    file: "../branding/assets/files/logo-on-light.png",
    sha256: "8dcb181e192db4461106fefc8318dfea7ea2b8eca9413d89cb1ac715194345a5"
  }
};

const COLORS = {
  raspberry: "#E62158",
  gunmetal: "#1D2B35",
  antiFlashWhite: "#ECF0F1",
  muted: "#5B6C75",
  border: "#D8E0E2"
} as const;

const TABLE_WIDTHS = ["*", 58, 76, 56, 50, 60] as const;

interface LoadedAssets {
  readonly regular: Buffer;
  readonly bold: Buffer;
  readonly faces: readonly FontkitFont[];
  readonly images: ReadonlyMap<string, string>;
}

export interface NativePdfRendererOptions {
  /** Overrides of asset file locations (tests: prove a missing or altered asset fails safely). */
  readonly assetPaths?: Partial<Record<"regular" | "bold" | "logo", string>>;
}

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function readPinned(file: string, expectedSha256: string): Buffer {
  const bytes = fs.readFileSync(file);

  if (sha256(bytes) !== expectedSha256) {
    throw new Error("asset does not match its pinned hash");
  }

  return bytes;
}

function loadAssets(options: NativePdfRendererOptions): LoadedAssets {
  const fontPath = (face: "regular" | "bold") =>
    options.assetPaths?.[face] ?? path.resolve(__dirname, "assets/fonts", RENDERER_PROFILE.fonts[face].file);
  const regular = readPinned(fontPath("regular"), RENDERER_PROFILE.fonts.regular.sha256);
  const bold = readPinned(fontPath("bold"), RENDERER_PROFILE.fonts.bold.sha256);
  const images = new Map<string, string>();

  for (const [assetId, asset] of Object.entries(IMAGE_ASSETS)) {
    const bytes = readPinned(options.assetPaths?.logo ?? path.resolve(__dirname, asset.file), asset.sha256);
    images.set(assetId, `data:image/png;base64,${bytes.toString("base64")}`);
  }

  return { regular, bold, faces: [fontkit.create(regular), fontkit.create(bold)], images };
}

/** Every string a model will show (issuedAt, versions and asset ids are not shown). */
function displayedStrings(value: unknown, key = ""): string[] {
  if (key === "issuedAt" || key === "templateVersion" || key === "logoAssetId") {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => displayedStrings(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([childKey, child]) => displayedStrings(child, childKey));
  }

  return [];
}

const cell = (value: string, style: string, alignment?: "right") => ({ text: value, style, ...(alignment ? { alignment } : {}) });

export class NativePdfRenderer implements PdfRendererPort {
  readonly rendererVersion = RENDERER_VERSION;
  private readonly assets: LoadedAssets | null;
  private readonly glyphSupport = new Map<number, boolean>();

  constructor(options: NativePdfRendererOptions = {}) {
    this.assets = NativePdfRenderer.load(options);
  }

  /** Pinned assets, or null when an asset or the running stack does not match the profile (never throws). */
  private static load(options: NativePdfRendererOptions): LoadedAssets | null {
    try {
      return rendererRuntimeMismatches().length === 0 ? loadAssets(options) : null;
    } catch {
      return null;
    }
  }

  async renderPdf(model: IssuedQuoteDocumentModelV2): Promise<Buffer> {
    const assets = this.requireAssets();
    const logo = assets.images.get(model.issuer.logoAssetId);

    if (!logo) {
      throw new DocumentRenderError("renderer_unavailable");
    }

    this.assertGlyphs([...displayedStrings(model), formalFooterText(model), TEMPLATE_V4.pageLabel(1, 1)], assets);

    try {
      return await this.render(buildDocumentDefinition(model, logo), assets);
    } catch {
      throw new DocumentRenderError("render_failed");
    }
  }

  /**
   * Readiness: the pinned assets loaded and the real printer, fonts and logo
   * produce a PDF in memory. Nothing is written and no quote is issued.
   */
  async probe(): Promise<ProbeOutcome> {
    if (!this.assets) {
      return probeFailed("renderer_unavailable");
    }

    try {
      const [logo] = [...this.assets.images.values()];
      const buffer = await this.render(
        {
          content: [{ image: LOGO_IMAGE_KEY, width: 40 }, { text: "readiness probe ÁÑ€✓", bold: true }],
          images: { [LOGO_IMAGE_KEY]: logo! },
          defaultStyle: { font: FONT_FAMILY },
          info: { creationDate: new Date(0) }
        },
        this.assets
      );

      return buffer.subarray(0, 5).toString("latin1") === "%PDF-" ? PROBE_OK : probeFailed("renderer_unavailable");
    } catch {
      return probeFailed("renderer_unavailable");
    }
  }

  private requireAssets(): LoadedAssets {
    if (!this.assets) {
      throw new DocumentRenderError("renderer_unavailable");
    }

    return this.assets;
  }

  /** Rejects text the pinned font set cannot draw in every face (unsupported_glyph). */
  private assertGlyphs(strings: readonly string[], assets: LoadedAssets): void {
    const missing = new Set<string>();

    for (const value of strings) {
      for (const character of value) {
        const codePoint = character.codePointAt(0)!;
        let supported = this.glyphSupport.get(codePoint);

        if (supported === undefined) {
          supported = assets.faces.every((face) => face.hasGlyphForCodePoint(codePoint));
          this.glyphSupport.set(codePoint, supported);
        }

        if (!supported) {
          missing.add(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
        }
      }
    }

    if (missing.size > 0) {
      throw new DocumentRenderError("unsupported_glyph", [...missing].sort());
    }
  }

  private render(definition: Record<string, unknown>, assets: LoadedAssets): Promise<Buffer> {
    const printer = new PdfPrinter({
      [FONT_FAMILY]: { normal: assets.regular, bold: assets.bold, italics: assets.regular, bolditalics: assets.bold }
    });
    const document = printer.createPdfKitDocument(definition);

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
}

export function formalFooterText(model: IssuedQuoteDocumentModelV2): string {
  return [model.issuer.legalName, model.issuer.website, model.quoteNumber].filter((value): value is string => value !== null).join(" · ");
}

/**
 * The pdfmake document definition of a formal quote (template v4 layout).
 * Pure and exported so tests can prove that model values only ever reach
 * `text` properties; images, fonts and every other resource-bearing property
 * are code constants.
 */
export function buildDocumentDefinition(model: IssuedQuoteDocumentModelV2, logoDataUri: string): Record<string, unknown> {
const footerText = formalFooterText(model);
  const t = TEMPLATE_V4;
  const amountsRow = (first: unknown, quantity: string, unitAmount: string, taxBasis: string, net: string, tax: string, gross: string) => [
    first,
    cell(quantity, "body", "right"),
    { stack: [cell(unitAmount, "body", "right"), cell(taxBasis, "mutedSmall", "right")] },
    cell(net, "body", "right"),
    cell(tax, "body", "right"),
    cell(gross, "bodyStrong", "right")
  ];
  const tableHeader = [
    cell(t.columns.description, "tableHeader"),
    cell(t.columns.quantity, "tableHeader", "right"),
    cell(t.columns.unitAmount, "tableHeader", "right"),
    cell(t.columns.net, "tableHeader", "right"),
    cell(t.columns.tax, "tableHeader", "right"),
    cell(t.columns.gross, "tableHeader", "right")
  ];
  const tableLayout = {
    fillColor: (rowIndex: number) => (rowIndex === 0 ? COLORS.antiFlashWhite : null),
    hLineColor: () => COLORS.border,
    vLineColor: () => COLORS.border,
    hLineWidth: () => 0.5,
    vLineWidth: () => 0,
    paddingLeft: () => 5,
    paddingRight: () => 5,
    paddingTop: () => 5,
    paddingBottom: () => 5
  };
  const { totals } = model;

  const content: unknown[] = [
    {
      columns: [
        { image: LOGO_IMAGE_KEY, width: 170, margin: [0, 0, 18, 0] },
        {
          stack: [
            cell(t.documentTitle, "documentLabel", "right"),
            cell(model.quoteNumber, "quoteNumber", "right"),
            cell(model.issueDate, "body", "right"),
            cell(model.validityStatement, "bodyStrong", "right")
          ],
          width: "*"
        }
      ],
      columnGap: 18,
      margin: [0, 0, 0, 20]
    },
    {
      table: {
        widths: ["*", "*"],
        body: [
          [
            {
              stack: [
                cell(t.issuerHeading, "sectionLabel"),
                cell(model.issuer.legalName, "bodyStrong"),
                ...model.issuer.rows.map((row) => cell(row, "body")),
                ...(model.issuer.website ? [cell(model.issuer.website, "body")] : [])
              ],
              margin: [0, 0, 12, 0]
            },
            {
              stack: [cell(t.customerHeading, "sectionLabel"), ...model.customer.map((row) => cell(row.text, row.strong ? "bodyStrong" : "body"))],
              margin: [12, 0, 0, 0]
            }
          ]
        ]
      },
      layout: "noBorders",
      margin: [0, 0, 0, 18]
    },
    cell(t.linesHeading, "sectionLabel"),
    {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        keepWithHeaderRows: 1,
        widths: TABLE_WIDTHS,
        body: [
          tableHeader,
          ...model.lines.map((line) =>
            amountsRow(
              { stack: [cell(line.description, "bodyStrong"), ...line.details.map((detail) => cell(detail, "mutedSmall"))] },
              line.quantity,
              line.unitAmount,
              line.taxBasis,
              line.net,
              line.tax,
              line.gross
            )
          )
        ]
      },
      layout: tableLayout,
      margin: [0, 0, 0, 14]
    },
    cell(t.shippingHeading, "sectionLabel"),
    model.shipping
      ? {
          table: {
            dontBreakRows: true,
            widths: TABLE_WIDTHS,
            body: [
              amountsRow(
                { stack: model.shipping.rows.map((row, index) => cell(row, index === 0 ? "bodyStrong" : "body")) },
                "1",
                model.shipping.amount,
                model.shipping.taxBasis,
                model.shipping.net,
                model.shipping.tax,
                model.shipping.gross
              )
            ]
          },
          layout: { ...tableLayout, fillColor: () => null },
          margin: [0, 0, 0, 14]
        }
      : { ...cell(model.shippingAbsent ?? t.shippingAbsent, "body"), margin: [0, 0, 0, 14] },
    {
      columns: [
        {
          stack: [
            cell(model.currencyLabel, "body"),
            ...(model.taxStatement ? [cell(model.taxStatement, "body")] : []),
            cell(model.validityStatement, "body")
          ],
          width: "*"
        },
        {
          table: {
            widths: ["*", 90],
            body: [
              [cell(t.totals.net, "mutedSmall"), cell(totals.net, "body", "right")],
              ...(totals.exemptNet ? [[cell(t.totals.exemptNet, "mutedSmall"), cell(totals.exemptNet, "body", "right")]] : []),
              [cell(t.totals.tax, "mutedSmall"), cell(totals.tax, "body", "right")],
              [cell(t.totals.gross, "totalLabel"), cell(totals.gross, "totalValue", "right")]
            ]
          },
          layout: "noBorders",
          width: 210
        }
      ],
      columnGap: 24,
      unbreakable: true
    }
  ];

  return {
    pageSize: "A4",
    pageMargins: [40, 44, 40, 44],
    compress: true,
    content,
    images: { [LOGO_IMAGE_KEY]: logoDataUri },
    defaultStyle: { font: FONT_FAMILY, fontSize: 8, color: COLORS.gunmetal },
    styles: {
      documentLabel: { fontSize: 8, bold: true, color: COLORS.raspberry, characterSpacing: 1.2 },
      quoteNumber: { fontSize: 17, bold: true, color: COLORS.gunmetal, margin: [0, 2, 0, 4] },
      sectionLabel: { fontSize: 7.5, bold: true, color: COLORS.muted, characterSpacing: 1.1, margin: [0, 0, 0, 5] },
      body: { fontSize: 8, color: COLORS.gunmetal },
      bodyStrong: { fontSize: 8, bold: true, color: COLORS.gunmetal },
      mutedSmall: { fontSize: 7, color: COLORS.muted },
      tableHeader: { fontSize: 6.5, bold: true, color: COLORS.gunmetal },
      totalLabel: { fontSize: 10, bold: true, color: COLORS.gunmetal },
      totalValue: { fontSize: 13, bold: true, color: COLORS.raspberry }
    },
    header: () => ({ canvas: [{ type: "rect", x: 0, y: 0, w: 595.28, h: 4, color: COLORS.raspberry }] }),
    footer: (currentPage: number, pageCount: number) => ({
      columns: [cell(footerText, "mutedSmall"), cell(t.pageLabel(currentPage, pageCount), "mutedSmall", "right")],
      margin: [40, 10, 40, 0]
    }),
    info: {
      title: t.pdfTitle(model.quoteNumber),
      author: model.issuer.legalName,
      subject: t.pdfSubject,
      creator: t.pdfCreator,
      producer: RENDERER_VERSION,
      creationDate: new Date(model.issuedAt)
    }
  };
}
