import { z } from "zod";

import { text } from "../create-quote-request";

/*
 * `POST /v2/quotes/{quoteId}/deliveries/email` request rules (Domain §10.2,
 * openapi `EmailDeliveryRequest`, R1.6 pre-flight audit §27).
 *
 * The V1 `normalizeEmailAddress` is deliberately NOT used: its pattern
 * accepts multi-recipient constructs such as `a>,<victim@evil.com`. A
 * delivery address is one bare RFC 5321 mailbox, validated with the same
 * validator as the V2 customer email (`z.email().max(254)`) plus an explicit
 * character deny-list as defense in depth, so a future validator change
 * cannot silently re-admit header or recipient injection.
 */

// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const FORBIDDEN_MAILBOX_CHARACTERS = /[\s\x00-\x1F\x7F<>,;:"()[\]\\]/;

/** True for exactly one mailbox: one `@`, no whitespace, control, quoting, grouping or list syntax. */
export function isSingleMailbox(value: string): boolean {
  return !FORBIDDEN_MAILBOX_CHARACTERS.test(value) && value.indexOf("@") > 0 && value.indexOf("@") === value.lastIndexOf("@");
}

/** Contract `Email` for a delivery target: the V2 customer-email validator plus the single-mailbox guard. */
export const mailbox = z
  .email()
  .max(254)
  .refine(isSingleMailbox, { params: { code: "invalid" }, message: "must be exactly one mailbox" });

/** openapi `EmailDeliveryRequest` (closed). */
export const emailDeliveryRequestSchema = z.strictObject({
  recipient: z
    .strictObject({
      email: mailbox,
      name: text(200).optional()
    })
    .optional()
});

export type EmailDeliveryRequest = z.infer<typeof emailDeliveryRequestSchema>;

export interface ResolvedRecipient {
  readonly email: string;
  readonly name: string | null;
  readonly source: "request" | "customer";
}

/**
 * Recipient selection (Domain §10.2): `recipient.email`, else the frozen
 * `customer.email`, else null (→ `422 delivery_recipient_missing`).
 *
 * Name: the request's `recipient.name` when the address comes from the
 * request (never a customer name for an address the caller chose). When the
 * address is the customer's, the customer's own person name for it:
 * `displayName` (guest/person) or `contactName` (company), else null. A
 * company `legalName` is an organization, not a person, and is not used.
 * Nothing is fabricated, and no customer service is queried: the source is
 * the immutable snapshot stored at issue acceptance.
 *
 * A stored customer email that does not pass the strict mailbox check
 * (possible only for migrated legacy data) is not a usable recipient.
 */
export function resolveRecipient(request: EmailDeliveryRequest, customer: Record<string, unknown>): ResolvedRecipient | null {
  if (request.recipient) {
    return { email: request.recipient.email, name: request.recipient.name ?? null, source: "request" };
  }

  const email = customer.email;

  if (typeof email !== "string" || !mailbox.safeParse(email).success) {
    return null;
  }

  const personName = customer.kind === "company" ? customer.contactName : customer.displayName;
  const name = typeof personName === "string" && text(200).safeParse(personName).success ? personName : null;
  return { email, name, source: "customer" };
}

/** Upper bound of `quote_deliveries.recipient_masked` and the contract `recipientMasked`. */
const MAX_MASKED_LENGTH = 254;

/**
 * Public masked form (openapi `Delivery.recipientMasked`, example
 * `ca***@example.com`): the first two characters of the local part, `***`,
 * then `@domain`. A local part of one or two characters shows only its first
 * character, so a short address is never returned whole. If the domain alone
 * would exceed the column bound, it is masked too. Deterministic.
 */
export function maskRecipient(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, local.length > 2 ? 2 : 1);
  const masked = `${visible}***@${domain}`;

  return masked.length <= MAX_MASKED_LENGTH ? masked : `${visible}***@***`;
}

/**
 * The email provider is not configured (Domain §10.1). The request queues
 * nothing and binds nothing; HTTP `503 dependency_unavailable` with
 * `details.dependency = "email_provider"`.
 */
export class EmailProviderDisabledError extends Error {
  override readonly name = "EmailProviderDisabledError";

  constructor() {
    super("The email provider is not configured; nothing was queued.");
  }
}
