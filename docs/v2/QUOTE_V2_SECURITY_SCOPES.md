# Quote Service V2 — Principals, Scopes and Security

Status: **FROZEN (R1.2)**. Normative for authorization semantics; the
credential mechanism is an implementation choice constrained by §4.
Per-operation scopes are also declared in [openapi.yaml](openapi.yaml) as
`x-required-scopes` / `x-conditional-scopes`.

## 1. Principal model

- Every request except `GET /health/live` and `GET /health/ready` is made by
  exactly one **authenticated principal** (`principalId`, a stable lowercase
  code such as `sales-integration` or `backoffice`).
- The principal is derived **only** from the credential. No request member
  can assert, change or elevate the actor. External correlation, customer
  data and notes are claims, never authority.
- Reserved principal ids: `system` (owner jobs: issuance worker, expiry job,
  deadline sweep) and `legacy-v1` (migrated V1 data). No credential maps to
  them.
- A principal holds a fixed set of scopes. Scopes are additive; there is no
  wildcard and no implicit hierarchy except the visibility rule in §3.
- Idempotency bindings are scoped by principal (see
  [idempotency](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md#2-keys-scope-and-fingerprint)).

## 2. Scope matrix

| Scope | Grants | Endpoints |
|---|---|---|
| `quotes:create` | Transactional create-and-issue | `POST /v2/quotes` |
| `quotes:draft:write` | Create and edit drafts | `POST /v2/quotes/drafts`, `PATCH /v2/quotes/{id}/draft` |
| `quotes:issue` | Issue a draft | `POST /v2/quotes/{id}/issue` |
| `quotes:read` | Read visible quotes, operations, own idempotency bindings, deliveries | `GET /v2/quotes/{id}`, `GET /v2/quotes`, `GET /v2/operations/{id}`, `GET /v2/idempotency/current`, `GET /v2/quotes/{id}/deliveries/{deliveryId}` |
| `quotes:read:any` | Extends visibility to all quotes (§3) | (modifier) |
| `quotes:document:read` | Download issued PDF bytes of visible quotes | `GET /v2/quotes/{id}/document` |
| `quotes:cancel` | Cancel visible drafts and issued quotes | `POST /v2/quotes/{id}/cancel` |
| `quotes:validity:override` | Send `validityOverride` (additionally to the endpoint's scope) | member of `POST /v2/quotes`, `POST /v2/quotes/{id}/issue` |
| `quotes:delivery:email` | Queue an email delivery of a visible issued quote | `POST /v2/quotes/{id}/deliveries/email` |
| `quotes:audit:read` | Read the audit history of visible quotes | `GET /v2/quotes/{id}/audit` |
| `service:health:dependencies` | Sanitized dependency and worker details | `GET /health/dependencies` |

Missing scope → `403 forbidden` with `details.requiredScope`, evaluated before
any idempotency lookup, so a forbidden request never binds or replays.

## 3. Visibility

A quote is **visible** to principal *P* iff it was created by *P*
(`createdByPrincipalId = P`) or *P* holds `quotes:read:any`. Operations,
deliveries, documents and audit events inherit the visibility of their quote.
Every quote-scoped endpoint (read, list, document, audit, cancel, draft edit,
issue, deliveries) requires visibility; a non-visible resource is answered
exactly like a missing one (`404 *_not_found`) to prevent enumeration.

## 4. Credential mechanism (initial and target)

| Requirement | Initial mechanism (R1.5) | Target |
|---|---|---|
| One credential per principal | Opaque random bearer tokens (≥ 256 bits), stored only as SHA-256 in a principal registry (`principalId → tokenHashes[], scopes[]`) loaded from the secret store | mTLS client certificates or signed short-lived workload tokens |
| Rotation | Up to two active tokens per principal; revocation by removing the hash; no restart required for registry reload | Automatic |
| Comparison | Constant-time hash comparison | — |
| No global token | The V1 single `SERVICE_AUTH_TOKEN` is retired; it never maps to a V2 principal | — |

Changing the mechanism never changes principals, scopes or visibility.

## 5. Example deployment profiles (configuration, not contract)

| Profile | Scopes |
|---|---|
| Transactional sales integration (automated, approval handled by the consumer) | `quotes:create`, `quotes:read`, `quotes:document:read` |
| Back-office operator | `quotes:draft:write`, `quotes:issue`, `quotes:read`, `quotes:read:any`, `quotes:document:read`, `quotes:cancel`, `quotes:audit:read` |
| Commercial supervisor | Back-office operator + `quotes:validity:override` |
| Customer communication (only once email is enabled) | `quotes:read`, `quotes:read:any`, `quotes:delivery:email` |
| Operations / monitoring | `service:health:dependencies`, `quotes:read`, `quotes:read:any`, `quotes:audit:read` |

No profile receives `quotes:validity:override` or `quotes:delivery:email`
unless that capability is explicitly approved for it.

## 6. Network, transport and data protection

- Listen on loopback or a private interface only; never on a public address.
  Ingress restricted to approved callers (host firewall / security group).
- Plain HTTP only on loopback; any hop between hosts uses TLS.
- No CORS (server-to-server API).
- Secrets (database roles, document/email credentials, token hashes) come
  from the deployment secret store; separate migration and runtime database
  roles; never in responses, logs, audit data or error details.
- Request logs record method, route template, status, latency, `requestId`,
  `principalId`, `quoteId`, `operationId` and the key hash; never bodies,
  customer names, RUT, email, phone, addresses, line descriptions, raw
  idempotency keys or authorization headers.
- Documents are served only through the authenticated document endpoint; there
  are no public, guessable or signed document URLs in V2. `quoteNumber` is
  sequential and therefore never used as an authorization token.
- Error responses are sanitized (`{code, message, requestId, details}`); no
  SQL, filesystem paths, provider payloads or stack traces.
- Customer snapshots and documents are personal data; access is limited to
  principals with the scopes above. Retention/deletion policy is an open
  decision recorded in the [freeze record](QUOTE_V2_CONTRACT_FREEZE.md).
