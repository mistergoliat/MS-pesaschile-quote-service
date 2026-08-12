import crypto from "node:crypto";

import {
  normalizeEmailAddress,
  sanitizeHeaderText
} from "../../domain";
import { EmailSendError } from "../../application/quote-delivery/retry-policy";
import type {
  EmailAddress,
  EmailAttachment,
  EmailSenderPort
} from "../../application/quote-delivery/ports/email-sender-port";

const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type FetchLike = typeof fetch;

export interface GmailEmailSenderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly user: string;
  readonly fetch?: FetchLike;
}

interface GmailTokenResponse {
  readonly access_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GmailSendResponse {
  readonly id?: string;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
    readonly errors?: Array<{
      readonly reason?: string;
      readonly message?: string;
    }>;
  };
}

export class GmailEmailSender implements EmailSenderPort {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly gmailUser: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: GmailEmailSenderConfig) {
    this.clientId = sanitizeHeaderText(config.clientId, "GOOGLE_GMAIL_CLIENT_ID", 500);
    this.clientSecret = sanitizeHeaderText(
      config.clientSecret,
      "GOOGLE_GMAIL_CLIENT_SECRET",
      500
    );
    this.refreshToken = sanitizeHeaderText(
      config.refreshToken,
      "GOOGLE_GMAIL_REFRESH_TOKEN",
      1_000
    );
    this.gmailUser = normalizeEmailAddress(config.user, "GOOGLE_GMAIL_USER");
    this.fetchImpl = config.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("Global fetch is not available for GmailEmailSender");
    }
  }

  async send(input: {
    readonly to: string;
    readonly from: EmailAddress;
    readonly replyTo?: string;
    readonly subject: string;
    readonly html: string;
    readonly attachments: readonly EmailAttachment[];
  }): Promise<{
    readonly providerMessageId?: string;
  }> {
    try {
      const accessToken = await this.fetchAccessToken();
      const rawMessage = encodeBase64Url(
        buildGmailMimeMessage({
          to: input.to,
          from: input.from,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          subject: input.subject,
          html: input.html,
          attachments: input.attachments
        })
      );
      const response = await this.fetchImpl(GMAIL_SEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          raw: rawMessage
        })
      });
      const payload = await parseJsonResponse<GmailSendResponse>(response);

      if (!response.ok) {
        throw classifyGmailHttpError({
          status: response.status,
          payload,
          operation: "send",
          gmailUser: this.gmailUser
        });
      }

      if (!payload.id) {
        throw new EmailSendError(
          "gmail_api_missing_message_id",
          `Gmail API did not return a message id for ${this.gmailUser}`,
          false
        );
      }

      return {
        providerMessageId: payload.id
      };
    } catch (error) {
      throw normalizeGmailSendError(error, this.gmailUser);
    }
  }

  private async fetchAccessToken(): Promise<string> {
    try {
      const response = await this.fetchImpl(GMAIL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token"
        }).toString()
      });
      const payload = await parseJsonResponse<GmailTokenResponse>(response);

      if (!response.ok) {
        throw classifyTokenError({
          status: response.status,
          payload,
          gmailUser: this.gmailUser
        });
      }

      if (!payload.access_token) {
        throw new EmailSendError(
          "gmail_oauth_missing_access_token",
          `OAuth token response for ${this.gmailUser} did not include an access token`,
          false
        );
      }

      return payload.access_token;
    } catch (error) {
      throw normalizeGmailSendError(error, this.gmailUser);
    }
  }
}

export function buildGmailMimeMessage(input: {
  readonly to: string;
  readonly from: EmailAddress;
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly attachments: readonly EmailAttachment[];
}): string {
  const to = normalizeEmailAddress(input.to, "to");
  const fromAddress = normalizeEmailAddress(input.from.address, "from.address");
  const fromName =
    input.from.name === undefined
      ? undefined
      : sanitizeHeaderText(input.from.name, "from.name", 200);
  const replyTo =
    input.replyTo === undefined
      ? undefined
      : normalizeEmailAddress(input.replyTo, "replyTo");
  const subject = sanitizeHeaderText(input.subject, "subject", 200);
  const htmlBody = input.html;
  const boundary = `quote-email-${crypto.randomUUID()}`;
  const headers = [
    `From: ${formatMailbox({ address: fromAddress, ...(fromName ? { name: fromName } : {}) })}`,
    `To: ${formatMailbox({ address: to })}`,
    ...(replyTo ? [`Reply-To: ${formatMailbox({ address: replyTo })}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0"
  ];

  if (input.attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(htmlBody, "utf8").toString("base64")),
      ""
    ].join("\r\n");
  }

  const parts = [
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(htmlBody, "utf8").toString("base64")),
    ""
  ];

  for (const attachment of input.attachments) {
    const filename = sanitizeHeaderText(attachment.filename, "attachment.filename", 255);
    const contentType = sanitizeHeaderText(
      attachment.contentType,
      "attachment.contentType",
      255
    );

    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${escapeQuotedHeaderValue(filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeQuotedHeaderValue(filename)}"`,
      "",
      wrapBase64(attachment.content.toString("base64")),
      ""
    );
  }

  parts.push(`--${boundary}--`, "");

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts
  ].join("\r\n");
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function formatMailbox(input: EmailAddress): string {
  const address = normalizeEmailAddress(input.address, "address");

  if (!input.name) {
    return `<${address}>`;
  }

  const name = sanitizeHeaderText(input.name, "name", 200);
  return `"${escapeQuotedHeaderValue(name)}" <${address}>`;
}

function escapeQuotedHeaderValue(value: string): string {
  return value.replace(/([\\"])/g, "\\$1");
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const bodyText = await response.text();

  if (bodyText.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return {
      error: {
        message: bodyText
      }
    } as T;
  }
}

function classifyTokenError(input: {
  readonly status: number;
  readonly payload: GmailTokenResponse;
  readonly gmailUser: string;
}): EmailSendError {
  const errorCode = input.payload.error ?? "gmail_oauth_failed";
  const description =
    input.payload.error_description ??
    `OAuth token refresh failed with status ${input.status} for ${input.gmailUser}`;

  if (errorCode === "invalid_grant") {
    return new EmailSendError("gmail_invalid_grant", description, false);
  }

  if (input.status === 429 || input.status >= 500) {
    return new EmailSendError("gmail_oauth_temporal_error", description, true);
  }

  if (input.status === 401 || input.status === 403) {
    return new EmailSendError("gmail_auth_invalid_credentials", description, false);
  }

  return new EmailSendError("gmail_oauth_failed", description, false);
}

function classifyGmailHttpError(input: {
  readonly status: number;
  readonly payload: GmailSendResponse;
  readonly operation: "send";
  readonly gmailUser: string;
}): EmailSendError {
  const errorMessage =
    input.payload.error?.message ??
    `Gmail ${input.operation} failed with status ${input.status} for ${input.gmailUser}`;
  const errorReason = input.payload.error?.errors?.[0]?.reason ?? input.payload.error?.status;

  if (input.status === 429) {
    return new EmailSendError("gmail_api_rate_limited", errorMessage, true);
  }

  if (input.status >= 500) {
    return new EmailSendError("gmail_api_server_error", errorMessage, true);
  }

  if (errorReason === "invalidGrant") {
    return new EmailSendError("gmail_invalid_grant", errorMessage, false);
  }

  if (input.status === 401 || input.status === 403) {
    return new EmailSendError("gmail_auth_invalid_credentials", errorMessage, false);
  }

  if (input.status === 400 || input.status === 422) {
    return new EmailSendError("gmail_invalid_message", errorMessage, false);
  }

  return new EmailSendError("gmail_api_failed", errorMessage, false);
}

function normalizeGmailSendError(error: unknown, gmailUser: string): EmailSendError {
  if (error instanceof EmailSendError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new EmailSendError(
      "gmail_network_timeout",
      `Timed out while calling Gmail API for ${gmailUser}`,
      true
    );
  }

  if (error instanceof TypeError) {
    return new EmailSendError(
      "gmail_network_error",
      `Network error while calling Gmail API for ${gmailUser}: ${error.message}`,
      true
    );
  }

  if (error instanceof Error) {
    return new EmailSendError("gmail_api_failed", error.message, false);
  }

  return new EmailSendError(
    "gmail_api_failed",
    `Unexpected Gmail delivery error for ${gmailUser}`,
    false
  );
}
