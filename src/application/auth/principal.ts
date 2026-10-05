/**
 * Authenticated principal model (docs/v2/QUOTE_V2_SECURITY_SCOPES.md §1–§2).
 *
 * A principal is resolved by the server from a credential, never from the
 * request: no body member, header other than Authorization, or query
 * parameter can assert, change or elevate it.
 */

/** Scope catalog, exactly as frozen in the security contract §2. */
export const QUOTE_SCOPES = [
  "quotes:create",
  "quotes:draft:write",
  "quotes:issue",
  "quotes:read",
  "quotes:read:any",
  "quotes:document:read",
  "quotes:cancel",
  "quotes:validity:override",
  "quotes:delivery:email",
  "quotes:audit:read",
  "service:health:dependencies"
] as const;

export type QuoteScope = (typeof QUOTE_SCOPES)[number];

/** Kind of caller, for operations and audit context only; authority comes from scopes. */
export const PRINCIPAL_TYPES = ["service", "operator"] as const;

export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * Owner identities that no credential may ever map to: `system` (owner jobs)
 * and `legacy-v1` (migrated V1 data).
 */
export const RESERVED_PRINCIPAL_IDS = ["system", "legacy-v1"] as const;

/** Same shape as the contract `SystemCode`, so the id is safe to persist anywhere the schema stores a principal. */
export const PRINCIPAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AuthenticatedPrincipal {
  /** Stable, server-owned identifier; never derived from credential material. */
  readonly principalId: string;
  readonly principalType: PrincipalType;
  readonly scopes: ReadonlySet<QuoteScope>;
}

export function hasScope(principal: AuthenticatedPrincipal, scope: QuoteScope): boolean {
  return principal.scopes.has(scope);
}
