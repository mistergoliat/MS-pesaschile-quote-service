import { formatCivilDate } from "../document/issued-quote-document-model";

/*
 * V2 email envelope (R1.6B, pre-flight audit §9–§10, decision A): a
 * communication wrapper around the formal PDF. The PDF is the only commercial
 * artifact; the email carries NO independent commercial authority:
 *
 *   - no lines, quantities, unit prices, net/tax/gross totals or shipping;
 *   - no tax statement (U2) and no "precios incluyen IVA";
 *   - no validity policy text (the old hard-coded "5 días");
 *   - no issuer legal name, RUT or address (U3), no personal signature;
 *   - no customer data beyond the optional greeting name.
 *
 * Inputs are frozen facts only: the quote number, the Chile civil issue date
 * (`validity.issueLocalDate`, never a UTC conversion) and the delivery's own
 * recipient-name snapshot. Nothing is looked up. The exact Spanish copy is
 * owner-approved at R1.7A (W8); approval alone does not change its bytes.
 */

/** Code-owned envelope version; bump on any semantic change of subject or body. */
export const QUOTE_EMAIL_ENVELOPE_VERSION = "quote-email-envelope-v3";
export const QUOTE_EMAIL_ENVELOPE_CONTENT_STATUS = "approved";

/** Brand display name (brand, not legal identity). */
export const EMAIL_BRAND_DISPLAY_NAME = "Pesas Chile";

const QUOTE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const CONTROL = /[\x00-\x1F\x7F]/;

export interface EmailEnvelopeInput {
  readonly quoteNumber: string;
  /** `YYYY-MM-DD` civil date in America/Santiago (frozen at issue acceptance). */
  readonly issueLocalDate: string;
  /** The delivery's recipient-name snapshot, or null for a generic greeting. */
  readonly recipientName: string | null;
}

/** Plain-text pieces; the HTML template escapes every one of them. */
export interface EmailEnvelope {
  readonly templateVersion: typeof QUOTE_EMAIL_ENVELOPE_VERSION;
  readonly subject: string;
  readonly greeting: string;
  readonly paragraphs: readonly string[];
  readonly signOff: string;
}

export class EmailEnvelopeError extends Error {
  override readonly name = "EmailEnvelopeError";
}

export function buildEmailEnvelope(input: EmailEnvelopeInput): EmailEnvelope {
  if (!QUOTE_NUMBER.test(input.quoteNumber)) {
    throw new EmailEnvelopeError("quote number is not a safe identifier");
  }

  const issued = formatCivilDate(input.issueLocalDate);
  const name = input.recipientName?.trim() ?? "";
  const greetingName = name.length > 0 && name.length <= 200 && !CONTROL.test(name) ? name : null;

  return {
    templateVersion: QUOTE_EMAIL_ENVELOPE_VERSION,
    subject: `Cotización ${EMAIL_BRAND_DISPLAY_NAME} ${input.quoteNumber}`,
    greeting: greetingName ? `Hola ${greetingName},` : "Hola,",
    paragraphs: [
      `Adjuntamos la cotización ${input.quoteNumber} emitida el ${issued}.`,
      "La cotización formal se encuentra en el archivo PDF adjunto.",
      "Para consultas, responde a este correo."
    ],
    signOff: EMAIL_BRAND_DISPLAY_NAME
  };
}
