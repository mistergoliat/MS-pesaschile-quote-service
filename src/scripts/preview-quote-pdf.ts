import fs from "node:fs/promises";
import path from "node:path";

import { createPdfFixture, createPdfRenderer } from "./pdf-fixture";

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.cwd(), ".tmp-pdf-previews");
  const renderer = createPdfRenderer();

  await fs.mkdir(outputDirectory, { recursive: true });

  for (const [label, itemCount] of [
    ["short", 1],
    ["long", 30],
    ["multipage", 100]
  ] as const) {
    const pdf = await renderer.renderPdf(createPdfFixture(itemCount));
    await fs.writeFile(path.join(outputDirectory, `quote-${label}.pdf`), pdf);
    console.log(JSON.stringify({ label, itemCount, bytes: pdf.byteLength }));
  }
}

void main();
