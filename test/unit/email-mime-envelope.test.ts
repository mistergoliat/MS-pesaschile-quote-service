import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { DELIVERY_MAX_ATTEMPTS, DELIVERY_RETRY_DELAYS_MS, nextRetry } from "../../src/application/quote-v2/delivery/delivery-policy";
import { buildEmailEnvelope, EmailEnvelopeError, QUOTE_EMAIL_ENVELOPE_VERSION } from "../../src/application/quote-v2/delivery/email-envelope";
import { documentFileName } from "../../src/application/quote-v2/document/document-file-name";
import { assertSingleMailbox, buildMimeMessage, deliveryMessageId, encodeHeaderText, MimeMessageError } from "../../src/infrastructure/email/mime-message";
import { renderEmailEnvelopeHtml } from "../../src/infrastructure/email/quote-email-envelope-template";
import { HOSTILE_RECIPIENTS } from "../helpers/hostile-recipients";

/*
 * R1.6B §24–§30, §64: MIME headers, deterministic Message-ID, attachment,
 * the V2 envelope (no commercial authority) and the W9 retry schedule.
 */

const DELIVERY_ID = "0b7f3c2e-9a41-4d6b-8f20-3c1d2e4f5a6b";
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(3000)]);

function message(overrides: Partial<Parameters<typeof buildMimeMessage>[0]> = {}): string {
  return buildMimeMessage({
    from: { address: "cotizaciones@pesaschile.cl", name: "Cotización Peñalolén Ñandú" },
    replyTo: "ventas@pesaschile.cl",
    to: "camila.rojas@example.com",
    subject: "Cotización Pesas Chile PC-000123 — Peñalolén Ñandú",
    deliveryId: DELIVERY_ID,
    html: "<p>Hola</p>",
    attachments: [{ filename: "PC-000123.pdf", contentType: "application/pdf", content: PDF }],
    inlineAssets: [],
    date: new Date("2026-10-06T12:00:00.000Z"),
    ...overrides
  });
}

const headerBlock = (raw: string) => raw.slice(0, raw.indexOf("\r\n\r\n"));
const unfold = (headers: string) => headers.replace(/\r\n[ \t]/g, " ");
const header = (raw: string, name: string) =>
  unfold(headerBlock(raw))
    .split("\r\n")
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));

/** Decode RFC 2047 B-words of an (unfolded) header value. */
function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\s*/g, (_match, b64: string) => Buffer.from(b64, "base64").toString("utf8")).trim();
}

/** Decoded bytes of every base64 MIME part with the given content type. */
function parts(raw: string, contentType: string): Buffer[] {
  const found: Buffer[] = [];
  const segments = raw.split(/\r\n--=_quote_[a-z]+_[0-9a-f]+(?:--)?\r\n/);

  for (const segment of segments) {
    const split = segment.indexOf("\r\n\r\n");
    const head = segment.slice(0, split);

    if (head.startsWith(`Content-Type: ${contentType}`) && head.includes("Content-Transfer-Encoding: base64")) {
      found.push(Buffer.from(segment.slice(split + 4).replace(/\r\n/g, ""), "base64"));
    }
  }

  return found;
}

describe("R1.6B MIME (P–Y)", () => {
  it("P: exactly one To mailbox, bare, never with the recipient name", () => {
    const raw = message();
    expect(header(raw, "To")).toEqual(["To: camila.rojas@example.com"]);
    expect(header(raw, "Cc")).toEqual([]);
    expect(header(raw, "Bcc")).toEqual([]);
    expect(header(raw, "Reply-To")).toEqual(["Reply-To: ventas@pesaschile.cl"]);
  });

  it("Q: hostile recipients are rejected again at the adapter boundary (independently of R1.6A)", () => {
    const extra = ["a>,<victim@evil.com", "a@b.cl, c@d.cl", "a@b.cl;c@d.cl", "a@b.cl\r\nBcc: v@evil.com", "a@b.cl\nX: y", " a@b.cl", "a b@c.cl", '"a"@b.cl', "Name <a@b.cl>", "a@b.cl (comment)", "<>", "a@b@c.cl", "a@[127.0.0.1]", "a@localhost", "ñ@b.cl", "a..b@c.cl", `${"a".repeat(65)}@b.cl`, ""];

    for (const hostile of [...HOSTILE_RECIPIENTS, ...extra]) {
      expect(() => assertSingleMailbox(hostile, "to"), hostile).toThrow(MimeMessageError);
      expect(() => message({ to: hostile }), hostile).toThrow(MimeMessageError);
    }

    for (const valid of ["camila.rojas@example.com", "a+tag@sub.example.cl", "o'brien@example.com", "x_y-z@example-domain.cl"]) {
      expect(assertSingleMailbox(valid, "to")).toBe(valid);
    }
  });

  it("R/S: Subject and From display name with accents are RFC 2047 encoded and decode back exactly", () => {
    const raw = message();
    const subject = header(raw, "Subject")[0]!.slice("Subject: ".length);
    const from = header(raw, "From")[0]!.slice("From: ".length);

    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(subject)).toBe("Cotización Pesas Chile PC-000123 — Peñalolén Ñandú");
    expect(from.endsWith(" <cotizaciones@pesaschile.cl>")).toBe(true);
    expect(decodeWords(from.slice(0, from.lastIndexOf(" <")))).toBe("Cotización Peñalolén Ñandú");

    // Every header line is 7-bit ASCII and every encoded word is at most 75 characters.
    for (const line of headerBlock(raw).split("\r\n")) {
      expect(line).toMatch(/^[\x20-\x7E]*$/);

      for (const word of line.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) {
        expect(word.length).toBeLessThanOrEqual(75);
      }
    }

    // Long multi-byte text is split on character boundaries.
    const long = "Ñandú Peñalolén Cotización ".repeat(6).trim();
    expect(decodeWords(unfold(encodeHeaderText(long)))).toBe(long);
    // Plain ASCII stays readable; an ASCII display name is a quoted string.
    expect(header(message({ subject: "Cotizacion PC-1", from: { address: "a@b.cl", name: 'Pesas "Chile"' } }), "Subject")).toEqual(["Subject: Cotizacion PC-1"]);
    expect(header(message({ from: { address: "a@b.cl", name: 'Pesas "Chile"' } }), "From")).toEqual(['From: "Pesas \\"Chile\\"" <a@b.cl>']);
  });

  it("T: CR/LF and control characters are rejected in every header input", () => {
    for (const subject of ["a\r\nBcc: x@y.cl", "a\nb", "a\rb", "a\u0000b", "a\u007fb", ""]) {
      expect(() => message({ subject }), JSON.stringify(subject)).toThrow(MimeMessageError);
    }

    expect(() => message({ from: { address: "a@b.cl", name: "x\r\nBcc: y@z.cl" } })).toThrow(MimeMessageError);
    expect(() => message({ replyTo: "a@b.cl\r\nBcc: y@z.cl" })).toThrow(MimeMessageError);
    expect(() => message({ from: { address: "a@b.cl, c@d.cl", name: null } })).toThrow(MimeMessageError);
  });

  it("U/V: deterministic Message-ID per delivery: same delivery → same id on every attempt; no recipient data, no randomness", () => {
    const first = header(message(), "Message-ID");
    const retry = header(message({ html: "<p>other</p>", date: new Date() }), "Message-ID");

    expect(first).toEqual([`Message-ID: <delivery.${DELIVERY_ID}@pesaschile.cl>`]);
    expect(retry).toEqual(first);
    expect(deliveryMessageId(DELIVERY_ID, "Cotizaciones@PesasChile.CL")).toBe(`<delivery.${DELIVERY_ID}@pesaschile.cl>`);
    expect(header(message({ deliveryId: "1b7f3c2e-9a41-4d6b-8f20-3c1d2e4f5a6b" }), "Message-ID")).not.toEqual(first);
    expect(first[0]).not.toContain("camila");
    expect(() => deliveryMessageId("../../x", "a@b.cl")).toThrow(MimeMessageError);
  });

  it("W/X/Y: one application/pdf attachment with the exact bytes and a quote-number file name", () => {
    const raw = message();
    const pdfs = parts(raw, "application/pdf");

    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]!.equals(PDF)).toBe(true);
    expect(raw).toContain('Content-Disposition: attachment; filename="PC-000123.pdf"');
    expect(documentFileName("PC-000123")).toBe("PC-000123.pdf");

    for (const filename of ['x"; y=".pdf', "../a.pdf", "a.exe", "a b.pdf", "a\r\n.pdf"]) {
      expect(() => message({ attachments: [{ filename, contentType: "application/pdf", content: PDF }] }), filename).toThrow(MimeMessageError);
    }

    expect(() => message({ inlineAssets: [{ contentId: "x>\r\nBcc: a@b.cl", filename: "logo.png", contentType: "image/png", content: Buffer.from("x") }] })).toThrow(MimeMessageError);
  });
});

describe("R1.6B V2 email envelope (Z–AB): communication only, no commercial authority", () => {
  const envelope = buildEmailEnvelope({ quoteNumber: "PC-000123", issueLocalDate: "2026-10-06", recipientName: "Camila <b>Rojas</b> & \"Co\"" });
  const rendered = renderEmailEnvelopeHtml(envelope);

  it("has a code-owned version, the provisional subject and Chile-civil issue date (no UTC conversion)", () => {
    expect(envelope.templateVersion).toBe(QUOTE_EMAIL_ENVELOPE_VERSION);
    expect(QUOTE_EMAIL_ENVELOPE_VERSION).toBe("quote-email-envelope-v3");
    expect(envelope.subject).toBe("Cotización Pesas Chile PC-000123");
    expect(envelope.paragraphs[0]).toBe("Adjuntamos la cotización PC-000123 emitida el 06/10/2026.");
    expect(rendered.html).toContain("La cotización formal se encuentra en el archivo PDF adjunto.");
    expect(buildEmailEnvelope({ quoteNumber: "PC-1", issueLocalDate: "2026-12-31", recipientName: null }).greeting).toBe("Hola,");
  });

  it("Z/AA: no signature, lines, quantities, prices, totals, tax, shipping, validity policy or issuer legal identity", () => {
    // Visible text only (markup and styles removed).
    const text = rendered.html
      .replace(/<head>[\s\S]*?<\/head>/, "")
      .replace(/<[^>]+>/g, " ")
      .toLowerCase();

    for (const forbidden of [/bastian/, /servicio al cliente/, /valech/, /\+56/, /\biva\b/, /impuesto/, /\bneto\b/, /total/, /cantidad/, /precio/, /despacho/, /env[ií]o/, /d[ií]as/, /v[aá]lid/, /vigencia/, /\brut\b/, /\bspa\b/, /maip[uú]/, /\$/, /\bclp\b/]) {
      expect(text, String(forbidden)).not.toMatch(forbidden);
    }

    expect(text.replace(/\s+/g, " ").trim()).toBe(
      "hola camila &lt;b&gt;rojas&lt;/b&gt; &amp; &quot;co&quot;, adjuntamos la cotización pc-000123 emitida el 06/10/2026. la cotización formal se encuentra en el archivo pdf adjunto. para consultas, responde a este correo. pesas chile"
    );

    expect(rendered.html).not.toMatch(/https?:\/\//);
    expect(rendered.html).not.toMatch(/href=/);
  });

  it("AB: the recipient name is HTML-escaped; hostile names never inject markup", () => {
    expect(rendered.html).toContain("Hola Camila &lt;b&gt;Rojas&lt;/b&gt; &amp; &quot;Co&quot;,");
    expect(rendered.html).not.toContain("<b>Rojas</b>");
    const script = renderEmailEnvelopeHtml(buildEmailEnvelope({ quoteNumber: "PC-1", issueLocalDate: "2026-01-01", recipientName: "<script>alert(1)</script>" })).html;
    expect(script).not.toContain("<script>");
    // A name with control characters falls back to the generic greeting.
    expect(buildEmailEnvelope({ quoteNumber: "PC-1", issueLocalDate: "2026-01-01", recipientName: "a\r\nb" }).greeting).toBe("Hola,");
  });

  it("only code-owned inline assets (the logo), referenced by CID", () => {
    expect(rendered.inlineAssets.map((asset) => [asset.contentId, asset.contentType])).toEqual([["pesaschile-logo", "image/png"]]);
    expect(rendered.html).toContain('src="cid:pesaschile-logo"');
    expect(rendered.inlineAssets[0]!.content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it("refuses an unsafe quote number or a malformed civil date", () => {
    expect(() => buildEmailEnvelope({ quoteNumber: "PC-1\r\nBcc: x", issueLocalDate: "2026-01-01", recipientName: null })).toThrow(EmailEnvelopeError);
    expect(() => buildEmailEnvelope({ quoteNumber: "PC-1", issueLocalDate: "2026-01-01T00:00:00Z", recipientName: null })).toThrow();
  });
});

describe("R1.6B retry policy W9 (BB–BD)", () => {
  const requestedAt = new Date("2026-10-06T00:00:00.000Z");

  it("BB/BC: delays 1 m / 5 m / 15 m / 1 h / 4 h; attempt 6 is the last", () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(6);
    expect(DELIVERY_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000, 14_400_000]);
    let now = requestedAt;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const decision = nextRetry({ attemptCount: attempt, requestedAt, now });
      expect(decision).toEqual({ kind: "retry", nextAttemptAt: new Date(now.getTime() + DELIVERY_RETRY_DELAYS_MS[attempt - 1]!) });
      now = decision.kind === "retry" ? decision.nextAttemptAt : now;
    }

    expect(nextRetry({ attemptCount: 6, requestedAt, now })).toEqual({ kind: "exhausted" });
    expect(nextRetry({ attemptCount: 7, requestedAt, now })).toEqual({ kind: "exhausted" });
  });

  it("BD: no retry is scheduled past requested_at + 24 h", () => {
    const late = new Date(requestedAt.getTime() + 24 * 3_600_000 - 30_000);
    expect(nextRetry({ attemptCount: 1, requestedAt, now: late })).toEqual({ kind: "exhausted" });
    const edge = new Date(requestedAt.getTime() + 24 * 3_600_000 - 60_000);
    expect(nextRetry({ attemptCount: 1, requestedAt, now: edge })).toEqual({ kind: "retry", nextAttemptAt: new Date(requestedAt.getTime() + 24 * 3_600_000) });
  });
});
