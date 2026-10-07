import crypto from "node:crypto";
import { safeErrorSummary } from "../application/safe-error";

import { createPdfFixture, createPdfRenderer } from "./pdf-fixture";

/** Concurrent renders on one renderer must all produce the same bytes (B3 runs one at a time; this proves it is safe anyway). */
async function main(): Promise<void> {
  const renderer = createPdfRenderer();
  const model = createPdfFixture(30);
  const results: Array<Record<string, number | string>> = [];

  for (const concurrency of [1, 5, 10]) {
    const before = process.memoryUsage().rss;
    const startedAt = performance.now();
    const pdfs = await Promise.all(Array.from({ length: concurrency }, () => renderer.renderPdf(model)));
    const hashes = new Set(pdfs.map((pdf) => crypto.createHash("sha256").update(pdf).digest("hex")));

    if (hashes.size !== 1) {
      throw new Error(`Non-identical PDFs at concurrency ${concurrency}`);
    }

    results.push({
      concurrency,
      rssDeltaMiB: Math.round(((process.memoryUsage().rss - before) / 1_048_576) * 10) / 10,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      pdfSha256: [...hashes][0]!
    });
  }

  console.log(JSON.stringify({ status: "ok", results }, null, 2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
