import fsPromises from "node:fs/promises";
import path from "node:path";
import { safeErrorSummary } from "../application/safe-error";

import { buildEmailEnvelope } from "../application/quote-v2/delivery/email-envelope";
import { buildIssuedQuoteDocumentModelV2 } from "../application/quote-v2/document/issued-quote-document-model";
import { documentFileName } from "../application/quote-v2/document/document-file-name";
import { PESASCHILE_CL_V2 } from "../application/quote-v2/document/issuer-profiles";
import { buildMimeMessage } from "../infrastructure/email/mime-message";
import { renderEmailEnvelopeHtml } from "../infrastructure/email/quote-email-envelope-template";
import { createIssuedSnapshotFixture, createPdfRenderer } from "./pdf-fixture";

/*
 * OFFLINE preview of the V2 email envelope (R1.6B), for the owner's copy
 * review (W8, R1.7). Sends nothing and contacts no provider: it writes the
 * HTML (with the inline logo as a data: URI for local viewing), exact copy,
 * MIME message and the attached synthetic production PDF to `.preview/`.
 *
 *   npm run email:preview -- [quoteNumber] [YYYY-MM-DD] [recipient name] [output directory]
 */

async function main(): Promise<void> {
  const [quoteNumber = "PC-000123", issueLocalDate = "2026-10-06", recipientName, directory = ".preview"] = process.argv.slice(2);
  const envelope = buildEmailEnvelope({ quoteNumber, issueLocalDate, recipientName: recipientName ?? null });
  const rendered = renderEmailEnvelopeHtml(envelope);
  let html = rendered.html;

  for (const asset of rendered.inlineAssets) {
    html = html.replaceAll(`cid:${asset.contentId}`, `data:${asset.contentType};base64,${asset.content.toString("base64")}`);
  }

  const outputDirectory = path.resolve(process.cwd(), directory);
  await fsPromises.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "quote-email-envelope.html");
  await fsPromises.writeFile(outputPath, html, "utf8");
  const snapshot = {
    ...createIssuedSnapshotFixture({ quoteNumber, issueLocalDate, lines: [{ description: "Producto de prueba", price: { amount: 19_990, taxBasis: "included", taxRate: "0.19" } }] }),
    issuerProfileId: PESASCHILE_CL_V2.id
  };
  const pdf = await createPdfRenderer().renderPdf(buildIssuedQuoteDocumentModelV2(snapshot));
  const filename = documentFileName(quoteNumber);
  const mime = buildMimeMessage({
    from: { address: "sender@example.com", name: "Pesas Chile" },
    replyTo: "reply@example.com",
    to: "recipient@example.com",
    subject: envelope.subject,
    deliveryId: "00000000-0000-4000-8000-000000000001",
    html: rendered.html,
    attachments: [{ filename, contentType: "application/pdf", content: pdf }],
    inlineAssets: rendered.inlineAssets,
    date: new Date(snapshot.issuedAt)
  });
  await fsPromises.writeFile(path.join(outputDirectory, filename), pdf);
  await fsPromises.writeFile(path.join(outputDirectory, "quote-email-envelope.eml"), mime, "utf8");
  await fsPromises.writeFile(path.join(outputDirectory, "quote-email-envelope.txt"), [envelope.subject, "", envelope.greeting, "", ...envelope.paragraphs, "", envelope.signOff, ""].join("\n"), "utf8");
  process.stdout.write(`${JSON.stringify({ templateVersion: envelope.templateVersion, subject: envelope.subject, outputPath })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeErrorSummary(error))}\n`);
  process.exitCode = 1;
});
