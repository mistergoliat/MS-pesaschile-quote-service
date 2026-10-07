import crypto from "node:crypto";

import type { OutboundMailAttachment, OutboundMailInlineAsset } from "../../application/quote-v2/delivery/mail-sender-port";
import { isStrictMailbox } from "../../application/quote-v2/delivery/strict-mailbox";

/*
 * RFC 5322 / MIME message builder for the V2 mail adapter (R1.6B).
 *
 * Defense in depth: R1.6A already validated the recipient strictly, and this
 * module validates it AGAIN, independently, as exactly one bare ASCII
 * addr-spec. Every header value is built here from typed fields; nothing
 * dynamic can become a header name, a boundary, a path or a raw header line:
 *
 *   - mailboxes: strict dot-atom `local@domain` (no display name, quotes,
 *     comments, groups, lists, whitespace or control characters);
 *   - Subject and From display name: CR/LF and control characters rejected,
 *     non-ASCII encoded as RFC 2047 `=?UTF-8?B?…?=` words (≤ 75 chars each);
 *   - Message-ID: deterministic `<delivery.{deliveryId}@{sender-domain}>`;
 *   - file names and content ids: conservative code-owned character sets;
 *   - bodies: base64 (76-column lines), so content can never contain a
 *     boundary line.
 */

export class MimeMessageError extends Error {
  override readonly name = "MimeMessageError";
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const CONTROL = /[\x00-\x1F\x7F]/;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SAFE_CONTENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Exactly one bare ASCII mailbox, or a MimeMessageError. Returned unchanged (the address is never rewritten). */
export function assertSingleMailbox(value: string, field: string): string {
  if (!isStrictMailbox(value)) {
    throw new MimeMessageError(`${field} must be exactly one bare mailbox`);
  }

  return value;
}

/** Domain part of a validated mailbox, lowercased. */
export function mailboxDomain(address: string): string {
  return assertSingleMailbox(address, "address").slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Deterministic RFC 5322 Message-ID for a delivery: same delivery → same id on every attempt; no recipient data, no randomness. */
export function deliveryMessageId(deliveryId: string, senderAddress: string): string {
  if (!UUID.test(deliveryId)) {
    throw new MimeMessageError("deliveryId must be a lowercase UUID");
  }

  return `<delivery.${deliveryId}@${mailboxDomain(senderAddress)}>`;
}

function assertHeaderText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL.test(value)) {
    throw new MimeMessageError(`${field} must be 1-${maxLength} characters without control characters`);
  }

  return value;
}

/**
 * RFC 2047 B-encoded words for `text`, each at most 75 characters, split on
 * code point boundaries (a multi-byte character is never cut), folded with
 * CRLF SP. Printable ASCII without `=?` is returned as is.
 */
export function encodeHeaderText(text: string): string {
  if (PRINTABLE_ASCII.test(text) && !text.includes("=?")) {
    return text;
  }

  // 75 - "=?UTF-8?B?".length - "?=".length = 63 → 60 base64 chars → 45 bytes per word.
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;

  for (const character of text) {
    const bytes = Buffer.from(character, "utf8");

    if (size + bytes.length > 45) {
      words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString("base64")}?=`);
      chunk = [];
      size = 0;
    }

    chunk.push(bytes);
    size += bytes.length;
  }

  if (chunk.length > 0) {
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString("base64")}?=`);
  }

  return words.join("\r\n ");
}

/** `From`-style mailbox with an optional display name (quoted-string if ASCII, RFC 2047 otherwise). */
function formatNamedMailbox(address: string, name: string | null, field: string): string {
  assertSingleMailbox(address, field);

  if (name === null) {
    return address;
  }

  assertHeaderText(name, `${field} display name`, 200);
  const phrase = PRINTABLE_ASCII.test(name) && !name.includes("=?") ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeHeaderText(name);
  return `${phrase} <${address}>`;
}

const wrapBase64 = (bytes: Buffer): string => bytes.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
const boundary = (kind: string): string => `=_quote_${kind}_${crypto.randomBytes(12).toString("hex")}`;

function htmlPart(html: string): string[] {
  return ['Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from(html, "utf8")), ""];
}

function inlinePart(asset: OutboundMailInlineAsset): string[] {
  if (!SAFE_CONTENT_ID.test(asset.contentId) || !SAFE_FILENAME.test(asset.filename) || asset.contentType !== "image/png") {
    throw new MimeMessageError("inline asset metadata is not code-owned");
  }

  return [
    `Content-Type: image/png; name="${asset.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${asset.contentId}>`,
    `Content-Disposition: inline; filename="${asset.filename}"`,
    "",
    wrapBase64(asset.content),
    ""
  ];
}

function attachmentPart(attachment: OutboundMailAttachment): string[] {
  if (!SAFE_FILENAME.test(attachment.filename) || !attachment.filename.endsWith(".pdf") || attachment.contentType !== "application/pdf") {
    throw new MimeMessageError("attachment must be a safely named application/pdf");
  }

  return [
    `Content-Type: application/pdf; name="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "",
    wrapBase64(attachment.content),
    ""
  ];
}

function multipart(type: "mixed" | "related", parts: readonly string[][]): string[] {
  const separator = boundary(type);
  return [
    `Content-Type: multipart/${type}; boundary="${separator}"`,
    "",
    ...parts.flatMap((part) => [`--${separator}`, ...part]),
    `--${separator}--`,
    ""
  ];
}

export interface MimeMessageInput {
  readonly from: { readonly address: string; readonly name: string | null };
  readonly replyTo: string | null;
  readonly to: string;
  readonly subject: string;
  readonly deliveryId: string;
  readonly html: string;
  readonly attachments: readonly OutboundMailAttachment[];
  readonly inlineAssets: readonly OutboundMailInlineAsset[];
  /** Header date (tests pin it). */
  readonly date?: Date;
}

/** CRLF-delimited RFC 5322 message. Throws MimeMessageError for anything that is not exactly one safe message. */
export function buildMimeMessage(input: MimeMessageInput): string {
  const to = assertSingleMailbox(input.to, "to");
  const headers = [
    `From: ${formatNamedMailbox(input.from.address, input.from.name, "from")}`,
    `To: ${to}`,
    ...(input.replyTo === null ? [] : [`Reply-To: ${assertSingleMailbox(input.replyTo, "replyTo")}`]),
    `Subject: ${encodeHeaderText(assertHeaderText(input.subject, "subject", 200))}`,
    `Message-ID: ${deliveryMessageId(input.deliveryId, input.from.address)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0"
  ];
  const body = input.inlineAssets.length > 0 ? multipart("related", [htmlPart(input.html), ...input.inlineAssets.map(inlinePart)]) : htmlPart(input.html);
  const content = input.attachments.length > 0 ? multipart("mixed", [body, ...input.attachments.map(attachmentPart)]) : body;

  return [...headers, ...content].join("\r\n");
}

/** Gmail `raw`: base64url of the message, unpadded. */
export function encodeBase64Url(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}
