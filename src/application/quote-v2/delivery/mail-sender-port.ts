/*
 * Generic mail port for V2 email delivery (Domain §10.2: "Gmail is one
 * provider adapter behind a generic mail port"). R1.6B final shape.
 *
 * The port answers ONE question for the delivery worker: can we prove the
 * provider did not accept the message?
 *
 *   accepted       the provider accepted it (any send-phase 2xx), with or
 *                  without a provider message id → `sent`
 *   not_accepted   provably NOT accepted (token phase, connect phase before
 *                  the request could reach the provider, explicit 4xx
 *                  rejection, invalid message) → retry or `failed`
 *   ambiguous      it may have been accepted (send-phase 5xx, timeout or reset
 *                  after the request was submitted, anything unclassifiable)
 *                  → `unknown`, never retried (amendment A6.3)
 *
 * Expected provider and network outcomes are returned, never thrown. A throw
 * is a programming error; the worker classifies it as ambiguous.
 *
 * No filesystem path, raw header or provider text crosses this port: the
 * attachment is verified bytes, headers are built by the adapter from typed
 * fields, and outcome codes are generic `email_*` codes (persisted as
 * `last_error_code`).
 */

/** Generic, provider-neutral delivery error codes (`^[a-z][a-z0-9_]{1,63}$`, `quote_deliveries.last_error_code`). */
export const EMAIL_DELIVERY_ERROR_CODES = {
  /** Token endpoint or connect phase unreachable / timed out / failed before the send request could reach the provider. */
  providerUnavailable: "email_provider_unavailable",
  /** Credentials rejected (OAuth `invalid_grant`, 401/403) before message acceptance (W5: retryable within the window). */
  authenticationFailed: "email_authentication_failed",
  /** Explicit provider rate limit (HTTP 429 or a 403 rate-limit reason). */
  rateLimited: "email_rate_limited",
  /** The provider explicitly rejected the message (400/413/422 and other definitive 4xx). Permanent. */
  providerRejected: "email_provider_rejected",
  /** The adapter refused to build the message (recipient/header validation). Nothing was sent. Permanent. */
  messageInvalid: "email_message_invalid",
  /** The provider may have accepted the message (A6.3). */
  outcomeUnknown: "email_outcome_unknown"
} as const;

export type MailErrorCode = (typeof EMAIL_DELIVERY_ERROR_CODES)[keyof typeof EMAIL_DELIVERY_ERROR_CODES];

export interface OutboundMailAttachment {
  /** Safe file name derived from the quote number only (never a storage key or path). */
  readonly filename: string;
  readonly contentType: "application/pdf";
  /** Verified committed bytes (never a filesystem path). */
  readonly content: Buffer;
}

/** A code-owned inline image (brand logo) referenced from the HTML as `cid:<contentId>`. */
export interface OutboundMailInlineAsset {
  readonly contentId: string;
  readonly filename: string;
  readonly contentType: "image/png";
  readonly content: Buffer;
}

export interface OutboundMail {
  /** The delivery id: the adapter derives the deterministic `Message-ID` from it. */
  readonly deliveryId: string;
  /** Exactly one bare mailbox. The recipient's name never goes into a header. */
  readonly to: string;
  /** Plain text; the adapter encodes it (RFC 2047) and rejects CR/LF. */
  readonly subject: string;
  /** Fully escaped HTML body (code-owned template). */
  readonly html: string;
  readonly attachments: readonly OutboundMailAttachment[];
  readonly inlineAssets: readonly OutboundMailInlineAsset[];
}

export type MailSendOutcome =
  | { readonly kind: "accepted"; readonly providerMessageId: string | null }
  | { readonly kind: "not_accepted"; readonly retryable: boolean; readonly code: MailErrorCode }
  | { readonly kind: "ambiguous"; readonly code: MailErrorCode };

export interface MailSenderPort {
  send(mail: OutboundMail): Promise<MailSendOutcome>;
}
