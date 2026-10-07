import {
  EMAIL_DELIVERY_ERROR_CODES as CODES,
  type MailSenderPort,
  type MailSendOutcome,
  type OutboundMail
} from "../../application/quote-v2/delivery/mail-sender-port";
import { assertSingleMailbox, buildMimeMessage, encodeBase64Url, MimeMessageError } from "./mime-message";

/*
 * Gmail adapter behind the generic V2 mail port (R1.6B, pre-flight audit §11,
 * amendment A6.3). One OAuth refresh-token grant and one `messages.send` per
 * attempt. The adapter never retries; it classifies:
 *
 * TOKEN PHASE (before any send request exists, so the message was provably
 * not sent): every failure is `not_accepted` and retryable (owner decision
 * W5: `invalid_grant`, 401/403, timeout, HTTP and network failures), so a
 * credential repair can take effect on the same delivery.
 *
 * SEND PHASE:
 *   2xx (with or without an id)                    accepted
 *   429, 403 with a rate-limit reason              not_accepted, retryable
 *   401, other 403 (rejected before acceptance)    not_accepted, retryable (W5)
 *   400/404/405/413/414/415/422                    not_accepted, permanent
 *   5xx, 408, any other status (A6.3)              ambiguous
 *   timeout, reset, close after dispatch           ambiguous
 *   connect failure proven by errno before the
 *   request could be transmitted (DNS, refused,
 *   unreachable, connect timeout, TLS validation)  not_accepted, retryable
 *   anything unclassifiable                        ambiguous
 *
 * The raw provider body, the tokens, the Authorization header and every
 * address stay inside this module: outcomes carry generic codes only, and
 * nothing here logs.
 */

export const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type FetchLike = typeof fetch;

export interface GmailMailSenderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly from: { readonly address: string; readonly name: string | null };
  readonly replyTo: string | null;
  /** Upper bound of the whole token exchange (request + response body). */
  readonly tokenTimeoutMs: number;
  /** Upper bound of the whole send request (request + response body). */
  readonly sendTimeoutMs: number;
  readonly fetch?: FetchLike;
  /** Test compositions only (a local fake provider). Production uses the Google endpoints. */
  readonly endpoints?: { readonly token: string; readonly send: string };
}

/**
 * errno / undici codes that prove the failure happened while establishing
 * the connection, i.e. before the HTTP request could reach the provider.
 * ECONNRESET, EPIPE, UND_ERR_SOCKET, closes and timeouts are NOT here: they
 * can happen after the request was written (ambiguous).
 */
const PRE_TRANSMISSION_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "EAI_NODATA",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);
const PERMANENT_SEND_STATUSES = new Set([400, 404, 405, 413, 414, 415, 422]);

/** Typed error codes along the cause chain (never the messages). */
export function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;

    if (typeof code === "string") {
      codes.push(code);
    }

    current = (current as { cause?: unknown }).cause;
  }

  return codes;
}

/** True only when a typed code proves the connection was never established. */
export function isProvenPreTransmissionFailure(error: unknown): boolean {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;

  if (name === "AbortError" || name === "TimeoutError") {
    return false;
  }

  const codes = errorCodes(error);
  return codes.length > 0 && codes.some((code) => PRE_TRANSMISSION_CODES.has(code)) && !codes.some((code) => code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET");
}

const notAccepted = (retryable: boolean, code: (typeof CODES)[keyof typeof CODES]): MailSendOutcome => ({ kind: "not_accepted", retryable, code });
const ambiguous: MailSendOutcome = { kind: "ambiguous", code: CODES.outcomeUnknown };

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Gmail error reason (`error.errors[0].reason` or `error.status`), parsed in memory only. */
function sendErrorReason(payload: Record<string, unknown> | null): string | null {
  const error = payload?.error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const errors = (error as { errors?: unknown }).errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const reason = typeof first === "object" && first !== null ? (first as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" ? reason : null;
}

const PROVIDER_ID = /^[\x21-\x7E]{1,500}$/;

export class GmailMailSender implements MailSenderPort {
  readonly #config: GmailMailSenderConfig;
  readonly #fetch: FetchLike;
  readonly #endpoints: { readonly token: string; readonly send: string };

  constructor(config: GmailMailSenderConfig) {
    assertSingleMailbox(config.from.address, "QUOTE_EMAIL_FROM_ADDRESS");

    if (config.replyTo !== null) {
      assertSingleMailbox(config.replyTo, "QUOTE_EMAIL_REPLY_TO");
    }

    if (!(config.tokenTimeoutMs > 0) || !(config.sendTimeoutMs > 0)) {
      throw new Error("Gmail timeouts must be positive");
    }

    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#endpoints = config.endpoints ?? { token: GMAIL_TOKEN_ENDPOINT, send: GMAIL_SEND_ENDPOINT };
  }

  /** Upper bound of one `send()` call: token phase + send phase (the worker checks it against the delivery lease). */
  get maxSendDurationMs(): number {
    return this.#config.tokenTimeoutMs + this.#config.sendTimeoutMs;
  }

  async send(mail: OutboundMail): Promise<MailSendOutcome> {
    let raw: string;

    try {
      raw = encodeBase64Url(
        buildMimeMessage({
          from: this.#config.from,
          replyTo: this.#config.replyTo,
          to: mail.to,
          subject: mail.subject,
          deliveryId: mail.deliveryId,
          html: mail.html,
          attachments: mail.attachments,
          inlineAssets: mail.inlineAssets
        })
      );
    } catch (error) {
      if (error instanceof MimeMessageError) {
        return notAccepted(false, CODES.messageInvalid);
      }

      throw error;
    }

    const token = await this.#accessToken();

    if (typeof token !== "string") {
      return token;
    }

    return this.#sendRaw(raw, token);
  }

  /** Token phase: the access token, or a retryable not-accepted outcome (nothing was sent). */
  async #accessToken(): Promise<string | MailSendOutcome> {
    const signal = AbortSignal.timeout(this.#config.tokenTimeoutMs);

    try {
      const response = await this.#fetch(this.#endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.#config.clientId,
          client_secret: this.#config.clientSecret,
          refresh_token: this.#config.refreshToken,
          grant_type: "refresh_token"
        }).toString(),
        signal
      });
      const payload = await readJson(response);

      if (response.ok) {
        const accessToken = payload?.access_token;
        return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : notAccepted(true, CODES.providerUnavailable);
      }

      const error = payload?.error;

      if (response.status === 429) {
        return notAccepted(true, CODES.rateLimited);
      }

      if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client" || response.status === 401 || response.status === 403) {
        return notAccepted(true, CODES.authenticationFailed);
      }

      return notAccepted(true, CODES.providerUnavailable);
    } catch {
      // Timeout, DNS, refused, reset: the send request was never created.
      return notAccepted(true, CODES.providerUnavailable);
    }
  }

  /** Send phase: only a typed pre-transmission failure or an explicit rejection is "not accepted". */
  async #sendRaw(raw: string, accessToken: string): Promise<MailSendOutcome> {
    const signal = AbortSignal.timeout(this.#config.sendTimeoutMs);
    let response: Response;

    try {
      response = await this.#fetch(this.#endpoints.send, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
        signal
      });
    } catch (error) {
      return isProvenPreTransmissionFailure(error) ? notAccepted(true, CODES.providerUnavailable) : ambiguous;
    }

    if (response.status >= 200 && response.status < 300) {
      // Accepted whatever happens to the body: a missing or unreadable id is not a failure.
      const id = (await readJson(response))?.id;
      return { kind: "accepted", providerMessageId: typeof id === "string" && PROVIDER_ID.test(id) ? id : null };
    }

    if (response.status === 429) {
      return notAccepted(true, CODES.rateLimited);
    }

    if (response.status === 401) {
      return notAccepted(true, CODES.authenticationFailed);
    }

    if (response.status === 403) {
      const reason = sendErrorReason(await readJson(response));
      return notAccepted(true, reason !== null && RATE_LIMIT_REASONS.has(reason) ? CODES.rateLimited : CODES.authenticationFailed);
    }

    if (PERMANENT_SEND_STATUSES.has(response.status)) {
      return notAccepted(false, CODES.providerRejected);
    }

    // 5xx (A6.3), 408, redirects and anything else: it may have been accepted.
    return ambiguous;
  }
}
