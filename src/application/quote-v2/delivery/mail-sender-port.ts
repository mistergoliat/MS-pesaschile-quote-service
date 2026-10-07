/*
 * Generic mail port for V2 email delivery (Domain §10.2: "Gmail is one
 * provider adapter behind a generic mail port").
 *
 * R1.6A only needs to know whether a sender is COMPOSED: the composition root
 * (src/app.ts) turns `MailSenderPort | null` into the boolean the delivery
 * request uses (configured → 202, not configured → 503 email_provider).
 * Nothing calls `send()` before the R1.6B delivery worker; the routes and the
 * request transaction never receive the port at all.
 *
 * The outcome model follows the R1.6 pre-flight audit (§11, §14): a send is
 * either accepted by the provider, known NOT to have been accepted (retryable
 * or permanent), or ambiguous (it may have been accepted: never retried
 * automatically, the delivery becomes `unknown`). R1.6B owns its final shape.
 */

export interface OutboundMailAttachment {
  readonly filename: string;
  readonly contentType: string;
  /** Verified bytes only (never a filesystem path). */
  readonly content: Buffer;
}

export interface OutboundMail {
  /** Deterministic RFC 5322 Message-ID derived from the delivery id. */
  readonly messageId: string;
  /** Exactly one mailbox. */
  readonly to: { readonly address: string; readonly name: string | null };
  readonly subject: string;
  readonly html: string;
  readonly attachments: readonly OutboundMailAttachment[];
}

export type MailSendOutcome =
  | { readonly kind: "accepted"; readonly providerMessageId: string | null }
  | { readonly kind: "not_accepted"; readonly retryable: boolean; readonly code: string }
  | { readonly kind: "ambiguous"; readonly code: string };

export interface MailSenderPort {
  send(mail: OutboundMail): Promise<MailSendOutcome>;
}
