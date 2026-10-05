import crypto from "node:crypto";

import type { AuthenticatedPrincipal } from "../auth/principal";

/** Operation names, exactly as frozen (openapi `IdempotentOperationName`). */
export const IDEMPOTENT_OPERATIONS = [
  "quote.create_and_issue",
  "quote.draft.create",
  "quote.draft.update",
  "quote.issue",
  "quote.cancel",
  "quote.delivery.email"
] as const;

export type IdempotentOperation = (typeof IDEMPOTENT_OPERATIONS)[number];

/** 1–200 printable ASCII characters, no spaces (openapi `IdempotencyKeyValue`). */
const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{1,200}$/;

export interface IdempotencyScope {
  readonly principalId: string;
  readonly operation: IdempotentOperation;
  /** SHA-256 of the raw key. The raw key is never stored or logged (invariant I-5). */
  readonly keyHash: string;
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function hashIdempotencyKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Binding scope `(principalId, operation, SHA-256(key))`. The principal is
 * always the authenticated one; there is deliberately no way to pass a
 * principal id taken from the request.
 */
export function idempotencyScope(
  principal: AuthenticatedPrincipal,
  operation: IdempotentOperation,
  rawKey: string
): IdempotencyScope {
  return {
    principalId: principal.principalId,
    operation,
    keyHash: hashIdempotencyKey(rawKey)
  };
}
