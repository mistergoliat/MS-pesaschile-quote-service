import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { safeErrorSummary } from "../application/safe-error";

import { buildIssuedQuoteDocumentModelV2 } from "../application/quote-v2/document/issued-quote-document-model";
import { RENDERER_VERSION } from "../infrastructure/documents/renderer-profile";
import { createPdfRenderer, productionPdfFixtures } from "./pdf-fixture";

function countPages(pdf: Buffer): number {
  return [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length;
}

/** Writes synthetic production formal-quote previews to .tmp-pdf-previews/. */
async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.cwd(), ".tmp-pdf-previews");
  const renderer = createPdfRenderer();

  await fs.mkdir(outputDirectory, { recursive: true });

  for (const [label, snapshot] of productionPdfFixtures()) {
    const model = buildIssuedQuoteDocumentModelV2(snapshot);
    const pdf = await renderer.renderPdf(model);
    await fs.writeFile(path.join(outputDirectory, `quote-${label}.pdf`), pdf);
    await fs.writeFile(path.join(outputDirectory, `quote-${label}.model.json`), `${JSON.stringify(model, null, 2)}\n`);
    console.log(
      JSON.stringify({ label, issuerProfileId: snapshot.issuerProfileId, rendererVersion: RENDERER_VERSION, templateVersion: model.templateVersion, lines: model.lines.length, pages: countPages(pdf), bytes: pdf.byteLength, sha256: crypto.createHash("sha256").update(pdf).digest("hex") })
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
