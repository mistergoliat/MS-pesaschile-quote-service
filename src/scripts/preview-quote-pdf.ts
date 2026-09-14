import fs from "node:fs/promises";
import path from "node:path";

import {
  createLongDescriptionPdfFixture,
  createMixedPdfFixture,
  createPdfFixture,
  createPdfRenderer,
  createSimplePdfFixture,
  PDF_RENDER_VERSION
} from "./pdf-fixture";

function countPages(pdf: Buffer): number {
  return [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.cwd(), ".tmp-pdf-previews");
  const renderer = createPdfRenderer();

  await fs.mkdir(outputDirectory, { recursive: true });

  const fixtures = [
    ["simple", createSimplePdfFixture()],
    ["mixed", createMixedPdfFixture()],
    ["long-description", createLongDescriptionPdfFixture()],
    ["30-lines", createPdfFixture(30)],
    ["multipage", createPdfFixture(100)]
  ] as const;

  for (const [label, fixture] of fixtures) {
    const pdf = await renderer.renderPdf(fixture);
    await fs.writeFile(path.join(outputDirectory, `quote-${label}.pdf`), pdf);
    console.log(
      JSON.stringify({
        label,
        renderVersion: PDF_RENDER_VERSION,
        itemCount: fixture.items.length,
        pages: countPages(pdf),
        bytes: pdf.byteLength
      })
    );
  }
}

void main();
