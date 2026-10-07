import crypto from "node:crypto";
import { safeErrorSummary } from "../application/safe-error";

import { buildIssuedQuoteDocumentModelV2 } from "../application/quote-v2/document/issued-quote-document-model";
import { RENDERER_VERSION } from "../infrastructure/documents/renderer-profile";
import { createPdfRenderer, goldenPdfFixtures } from "./pdf-fixture";

/**
 * Prints the SHA-256 of every golden formal-PDF fixture, plus the runtime that
 * produced them. Run in different processes, time zones, locales and OSes
 * (including the Linux runtime image); every run must print the same hashes.
 */
async function main(): Promise<void> {
  const renderer = createPdfRenderer();
  const hashes: Record<string, string> = {};

  for (const [name, snapshot] of goldenPdfFixtures()) {
    const pdf = await renderer.renderPdf(buildIssuedQuoteDocumentModelV2(snapshot));
    hashes[name] = crypto.createHash("sha256").update(pdf).digest("hex");
  }

  process.stdout.write(
    `${JSON.stringify({ rendererVersion: RENDERER_VERSION, node: process.version, platform: process.platform, arch: process.arch, tz: process.env.TZ ?? null, lang: process.env.LANG ?? null, hashes })}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exit(1);
});
