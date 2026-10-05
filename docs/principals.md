# Quote Service — Principals and Credentials (R1.5A · 1A)

Implements the frozen [security contract](v2/QUOTE_V2_SECURITY_SCOPES.md)
§1, §2 and §4 (initial mechanism). The contract is normative; this document
describes the implementation.

## 1. Model

```
AuthenticatedPrincipal {
  principalId:   stable server-owned id (lowercase system code, e.g. "sales-integration")
  principalType: "service" | "operator"     (context only; authority comes from scopes)
  scopes:        Set<QuoteScope>            (the 11 frozen scopes, no wildcard, no hierarchy)
}
```

- The principal comes **only** from the `Authorization: Bearer <token>`
  header, resolved through the registry.
- No body member, query parameter or other header can choose or change the
  principal id, its type or its scopes. Examples a caller might try:
  `principalId`, `scopes`, `actor`, `X-Principal-Id`.
- The credential is never the identity. `principalId` is configured
  separately, so a token can be rotated without changing the identity that
  `idempotency_bindings.principal_id`, audit `principal_id` and
  `quotes.created_by_principal_id` refer to.
- `system` and `legacy-v1` are reserved owner identities. The registry
  rejects them.
- Idempotency scope is `(authenticated principalId, operation,
  SHA-256(key))`. `idempotencyScope()` takes the authenticated principal and
  offers no way to pass a principal from the request.

## 2. Registry

Configured with exactly one of:

- `QUOTE_PRINCIPAL_REGISTRY_FILE`: path to a JSON file mounted from the
  secret store. Reloadable without restart.
- `QUOTE_PRINCIPAL_REGISTRY_JSON`: the same document inline, for secret
  stores that inject environment variables.

```json
{
  "version": 1,
  "principals": [
    {
      "principalId": "sales-integration",
      "principalType": "service",
      "scopes": ["quotes:create", "quotes:read", "quotes:document:read"],
      "tokenSha256": ["<sha256 hex of the active token>", "<optional second token during rotation>"]
    }
  ]
}
```

The registry stores **only SHA-256 hashes**. The raw token exists only in the
caller's secret store.

Startup validation is static: a failure exits 1 with `runtime.config_invalid`
and prints paths and rule messages only, never tokens or hashes. The
following are rejected:

- duplicate `principalId`;
- a token hash used twice, by different principals or by the same one;
- a reserved or non-canonical id;
- an unknown, repeated or missing scope;
- an unknown `principalType`;
- zero tokens, or more than two;
- a value that is not a hex SHA-256 (for example a raw token pasted by
  mistake);
- unknown members, an empty registry, a wrong `version`, invalid JSON, or an
  unreadable file.

## 3. Authentication and authorization

1. **Format:** the token must be printable ASCII, 43–512 characters. Shorter
   tokens cannot carry 256 bits and are rejected as invalid.
2. **Matching:** the presented token is hashed and compared against **every**
   stored hash with `timingSafeEqual`, with no early exit. Exactly one
   principal can match, because duplicates were rejected at startup.
3. **Missing or invalid credential:** `401 unauthenticated`.
4. **Missing scope:** `403 forbidden` with `details.requiredScope`.

Both checks run before any idempotency lookup (contract §2 and Domain §12),
so a forbidden request never binds and never replays.

Every business route must declare `config.requiredScope`. A route without one
makes startup fail, so no route can be added unprotected.
`GET /health/dependencies` requires `service:health:dependencies`.
`/health/live` and `/health/ready` stay public.

Error bodies carry `code`, `message`, `requestId` and, for 403,
`requiredScope`. Request logs never include the `Authorization` header,
tokens, hashes or raw idempotency keys; a test captures real log output to
prove this.

## 4. Operations

| Task | How |
|---|---|
| New principal | `npm run principals:token` prints `{token, tokenSha256}`. Give the token to the caller through its secret store, once. Add the hash and the scopes to the registry, then reload |
| Rotate | Add the new hash next to the old one (at most two), reload, switch the caller to the new token, remove the old hash, reload |
| Revoke | Remove the hash and reload |
| Reload (file source) | `kill -HUP <pid>`. The new registry is validated first: if it is invalid, the current one stays active and `principal_registry.reload_rejected` is logged (issues only). Success logs `principal_registry.reloaded` with the principal count |

The scope profiles in contract §5 are configuration examples, not code. No
principal receives `quotes:validity:override` or `quotes:delivery:email`
unless that capability was explicitly approved for it. A future production
caller, such as the transactional sales integration, is just a registry
entry; no caller-specific logic exists in the service.

## 5. Not in this step

- mTLS or signed workload tokens (the contract's target mechanism).
- Visibility filtering (`createdByPrincipalId` / `quotes:read:any`), which
  arrives with the V2 read routes.
- The acceptance transaction's replay and conflict decisions. The binding
  store only finds and inserts bindings scoped by the authenticated principal.
