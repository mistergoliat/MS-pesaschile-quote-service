import { createPdfFixture, createPdfRenderer } from "./pdf-fixture";

async function main(): Promise<void> {
  const renderer = createPdfRenderer();
  const samples: Array<Record<string, number | string>> = [];

  for (const itemCount of [10, 30]) {
    const before = process.memoryUsage().rss;
    const startedAt = performance.now();
    const pdf = await renderer.renderPdf(createPdfFixture(itemCount));
    const after = process.memoryUsage().rss;
    samples.push({
      renderer: "pdfmake",
      itemCount,
      rssBeforeBytes: before,
      rssPeakBytes: Math.max(before, after),
      rssAfterBytes: after,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      pdfBytes: pdf.byteLength
    });
  }

  console.log(JSON.stringify({ status: "ok", baseline: "unavailable-after-browser-removal", samples }, null, 2));
}

void main();
