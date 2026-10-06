import "dotenv/config";

import { loadEnv } from "../infrastructure/config/env";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "../infrastructure/branding/pesaschile-brand-v1";
import { buildQuoteEmailViewModel } from "../infrastructure/documents/quote-email-view-model";
import { renderQuoteEmailHtml } from "../infrastructure/documents/quote-email-template";
import { resolveQuoteEmailInlineAssets } from "../infrastructure/documents/quote-email-inline-assets";
import {
  GmailEmailSender,
  buildGmailMimeMessage
} from "../infrastructure/email/gmail-email-sender";
import { buildIssuedQuoteDocumentModelV2 } from "../application/quote-v2/document/issued-quote-document-model";
import { RENDERER_VERSION } from "../infrastructure/documents/renderer-profile";
import { createMixedLegacyEmailFixture } from "./legacy-email-fixture";
import { createMixedTaxFixture, createPdfRenderer } from "./pdf-fixture";

function assertSmokeCheck(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PDF email smoke check failed: ${message}`);
  }
}

function withoutWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

async function main(): Promise<void> {
  const env = loadEnv();
  const recipient = process.argv[2] ?? process.env.QUOTE_SMOKE_RECIPIENT;

  assertSmokeCheck(
    Boolean(recipient),
    "provide the recipient as the first argument or QUOTE_SMOKE_RECIPIENT"
  );
  assertSmokeCheck(
    env.QUOTE_EMAIL_PROVIDER === "gmail",
    "QUOTE_EMAIL_PROVIDER must be gmail"
  );

  // Email body: legacy V1 email view model (R1.6). Attachment: the V2 formal PDF.
  const snapshot = createMixedLegacyEmailFixture();
  const brand = createPesasChileBrandV1({ legalName: env.QUOTE_COMPANY_NAME });
  const senderSignature = createDefaultPesasChileSenderSignatureV1();
  const html = renderQuoteEmailHtml(
    buildQuoteEmailViewModel({
      snapshot,
      brand,
      emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
      senderSignature
    })
  );
  const pdf = await createPdfRenderer().renderPdf(buildIssuedQuoteDocumentModelV2(createMixedTaxFixture()));
  const subject = `Smoke PDF ${snapshot.quoteNumber} ${RENDERER_VERSION}`;
  const attachmentFilename = `Cotizacion-${snapshot.quoteNumber}.pdf`;
  const emailInput = {
    to: recipient!,
    from: {
      address: env.QUOTE_EMAIL_FROM_ADDRESS!,
      name: env.QUOTE_EMAIL_FROM_NAME!
    },
    ...(env.QUOTE_EMAIL_REPLY_TO ? { replyTo: env.QUOTE_EMAIL_REPLY_TO } : {}),
    subject,
    html,
    attachments: [
      {
        filename: attachmentFilename,
        contentType: "application/pdf",
        content: pdf
      }
    ]
  } as const;
  const mimeMessage = buildGmailMimeMessage({
    ...emailInput,
    inlineAssets: resolveQuoteEmailInlineAssets(html)
  });
  const compactMimeMessage = withoutWhitespace(mimeMessage);
  const htmlPayload = Buffer.from(html, "utf8").toString("base64");
  const pdfPayload = pdf.toString("base64");

  assertSmokeCheck(pdf.subarray(0, 5).toString("utf8") === "%PDF-", "PDF signature is invalid");
  assertSmokeCheck(
    mimeMessage.includes('Content-Type: multipart/mixed; boundary="quote-email-mixed-'),
    "MIME is not multipart/mixed"
  );
  assertSmokeCheck(
    mimeMessage.includes('Content-Type: text/html; charset="UTF-8"'),
    "HTML part is missing charset UTF-8"
  );
  assertSmokeCheck(
    mimeMessage.includes(`Content-Type: application/pdf; name="${attachmentFilename}"`),
    "PDF attachment MIME type or filename is invalid"
  );
  assertSmokeCheck(
    compactMimeMessage.includes(htmlPayload),
    "UTF-8 HTML payload is not present in the MIME message"
  );
  assertSmokeCheck(
    compactMimeMessage.includes(pdfPayload),
    "PDF payload is not present in the MIME message"
  );

  const expectedContent = [
    "Balanza industrial de plataforma 300 kg",
    "Instalación y calibración en terreno",
    "Despacho a domicilio",
    "Precios incluyen IVA"
  ];
  for (const value of expectedContent) {
    assertSmokeCheck(html.includes(value), `quote HTML is missing expected content: ${value}`);
  }

  const sender = new GmailEmailSender({
    clientId: env.GOOGLE_GMAIL_CLIENT_ID!,
    clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET!,
    refreshToken: env.GOOGLE_GMAIL_REFRESH_TOKEN!,
    user: env.GOOGLE_GMAIL_USER!
  });
  const providerResult = await sender.send(emailInput);

  console.log(
    JSON.stringify({
      status: "sent",
      providerMessageId: providerResult.providerMessageId ?? null,
      to: recipient,
      quoteNumber: snapshot.quoteNumber,
      rendererVersion: RENDERER_VERSION,
      pdfBytes: pdf.byteLength,
      checks: {
        pdfSignature: true,
        htmlCharsetUtf8: true,
        pdfContentType: true,
        htmlPayloadPresent: true,
        pdfPayloadPresent: true,
        quoteContentPresent: true
      }
    })
  );
}

void main();
