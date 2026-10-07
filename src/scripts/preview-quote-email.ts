import fsPromises from "node:fs/promises";
import path from "node:path";
import { safeErrorSummary } from "../application/safe-error";

import { buildEmailEnvelope } from "../application/quote-v2/delivery/email-envelope";
import { renderEmailEnvelopeHtml } from "../infrastructure/email/quote-email-envelope-template";

/*
 * OFFLINE preview of the V2 email envelope (R1.6B), for the owner's copy
 * review (W8, R1.7). Sends nothing and contacts no provider: it writes the
 * HTML (with the inline logo as a data: URI for local viewing) to
 * `.preview/quote-email-envelope.html`.
 *
 *   npm run email:preview -- [quoteNumber] [YYYY-MM-DD] [recipient name]
 */

async function main(): Promise<void> {
  const [quoteNumber = "PC-000123", issueLocalDate = "2026-10-06", recipientName] = process.argv.slice(2);
  const envelope = buildEmailEnvelope({ quoteNumber, issueLocalDate, recipientName: recipientName ?? null });
  const rendered = renderEmailEnvelopeHtml(envelope);
  let html = rendered.html;

  for (const asset of rendered.inlineAssets) {
    html = html.replaceAll(`cid:${asset.contentId}`, `data:${asset.contentType};base64,${asset.content.toString("base64")}`);
  }

  const outputDirectory = path.resolve(process.cwd(), ".preview");
  await fsPromises.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "quote-email-envelope.html");
  await fsPromises.writeFile(outputPath, html, "utf8");
  process.stdout.write(`${JSON.stringify({ templateVersion: envelope.templateVersion, subject: envelope.subject, outputPath })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
