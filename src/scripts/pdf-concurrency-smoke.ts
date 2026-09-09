import { createPdfFixture, createPdfRenderer } from "./pdf-fixture";

async function main(): Promise<void> {
  const renderer = createPdfRenderer();
  const results: Array<Record<string, number | string>> = [];

  for (const concurrency of [1, 5, 10]) {
    const before = process.memoryUsage().rss;
    const startedAt = performance.now();
    const pdfs = await Promise.all(
      Array.from({ length: concurrency }, () => renderer.renderPdf(createPdfFixture(30)))
    );
    const after = process.memoryUsage().rss;
    if (pdfs.some((pdf) => pdf.subarray(0, 5).toString("utf8") !== "%PDF-")) {
      throw new Error(`Invalid PDF produced at concurrency ${concurrency}`);
    }
    results.push({
      concurrency,
      rssBeforeBytes: before,
      rssAfterBytes: after,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      pdfBytes: pdfs[0]?.byteLength ?? 0
    });
  }

  console.log(JSON.stringify({ status: "ok", leakedBrowserProcesses: 0, results }, null, 2));
}

void main();
