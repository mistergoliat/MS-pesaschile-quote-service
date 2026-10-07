import crypto from "node:crypto";
import { safeErrorSummary } from "../application/safe-error";

import { RENDERER_VERSION } from "../infrastructure/documents/renderer-profile";
import { createPdfFixture, createPdfRenderer } from "./pdf-fixture";

/** Representative formal-PDF cost: one warm-up, then sequential renders (the intended one-at-a-time model). */
async function main(): Promise<void> {
  const renderer = createPdfRenderer();
  const samples: Array<Record<string, number | string>> = [];
  await renderer.renderPdf(createPdfFixture(1));

  for (const lineCount of [1, 10, 100]) {
    const model = createPdfFixture(lineCount);
    const durations: number[] = [];
    let rssPeak = process.memoryUsage().rss;
    let pdf: Buffer = Buffer.alloc(0);

    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      pdf = await renderer.renderPdf(model);
      durations.push(performance.now() - startedAt);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }

    durations.sort((a, b) => a - b);
    samples.push({
      lineCount,
      medianMs: Math.round(durations[2]! * 10) / 10,
      maxMs: Math.round(durations[4]! * 10) / 10,
      rssPeakMiB: Math.round((rssPeak / 1_048_576) * 10) / 10,
      pdfBytes: pdf.byteLength,
      pdfSha256: crypto.createHash("sha256").update(pdf).digest("hex")
    });
  }

  console.log(JSON.stringify({ rendererVersion: RENDERER_VERSION, node: process.version, platform: process.platform, samples }, null, 2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
