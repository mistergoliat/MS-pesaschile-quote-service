import fs from "node:fs/promises";
import path from "node:path";
import { safeErrorSummary } from "../application/safe-error";

import { buildIssuedQuoteDocumentModelV2 } from "../application/quote-v2/document/issued-quote-document-model";
import { RENDERER_VERSION } from "../infrastructure/documents/renderer-profile";
import { createIssuedSnapshotFixture, createLinesFixture, createMixedTaxFixture, createPdfRenderer } from "./pdf-fixture";

function countPages(pdf: Buffer): number {
  return [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
}

/** Writes synthetic formal-quote previews (template v4) to .tmp-pdf-previews/. */
async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.cwd(), ".tmp-pdf-previews");
  const renderer = createPdfRenderer();

  await fs.mkdir(outputDirectory, { recursive: true });

  const fixtures = [
    ["one-line", createLinesFixture(1)],
    ["mixed-tax-company", createMixedTaxFixture()],
    ["guest-no-shipping", createIssuedSnapshotFixture({ customer: { kind: "guest" }, lines: [{ description: "Kettlebell 8 kg", price: { amount: 19_990, taxBasis: "included", taxRate: "0.19" } }] })],
    ["30-lines", createLinesFixture(30)],
    ["100-lines", createLinesFixture(100)]
  ] as const;

  for (const [label, snapshot] of fixtures) {
    const model = buildIssuedQuoteDocumentModelV2(snapshot);
    const pdf = await renderer.renderPdf(model);
    await fs.writeFile(path.join(outputDirectory, `quote-${label}.pdf`), pdf);
    console.log(
      JSON.stringify({ label, rendererVersion: RENDERER_VERSION, templateVersion: model.templateVersion, lines: model.lines.length, pages: countPages(pdf), bytes: pdf.byteLength })
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
