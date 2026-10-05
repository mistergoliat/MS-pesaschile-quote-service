# Quote Service V2 — Domain Contract

Status: **FROZEN (R1.2)**. Normative. Machine contract: [openapi.yaml](openapi.yaml).
Companion specifications: [state machine](QUOTE_V2_STATE_MACHINE.md),
[idempotency and recovery](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md),
[validity policy](QUOTE_V2_VALIDITY_POLICY.md),
[security and scopes](QUOTE_V2_SECURITY_SCOPES.md),
[V1 → V2 migration](QUOTE_V2_V1_MIGRATION.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.
Where the prose and `openapi.yaml` disagree, that is a contract defect;
`openapi.yaml` governs shapes and this document governs behavior.

Baseline: Quote Service at `fade75d` (V1). Inputs: the J3A owner audit and the
R1.1 production readiness audit (both closed; listed in the
[freeze record](QUOTE_V2_CONTRACT_FREEZE.md)).

---

## 1. Domain model (Model B)

Quote Service is a **document and persistence owner with deterministic
arithmetic verification**. The caller resolves and freezes every commercial
value; Quote Service validates it, computes the owner amounts, persists an
immutable issued snapshot and renders an immutable document.

| Quote Service owns | Quote Service does not own |
|---|---|
| `quoteId`, `quoteNumber` | Catalog lookup, product discovery |
| Quote lifecycle (§3) | Stock / availability |
| Immutable issued commercial snapshot | Current price selection, promotions, discounts |
| Arithmetic verification and owner totals (§6) | Shipping rating, carrier or service selection |
| Validity policy and expiration (§7) | Customer master data / CRM identity |
| Issued document artifact (§9) | Sales opportunities or pipelines |
| Audit trail (§11) | Payment, order, acceptance |
| Idempotency and reconciliation (§10) | Consumer reasoning, approval or policy |
| Optional explicit email delivery (§10 of this doc: §10.2) | |

Invariants:

- **D-1** Quote Service MUST NOT call Catalog, Shipping, CRM, a pricing
  source or any other commercial owner in any operation.
- **D-2** Quote Service MUST NOT substitute, re-fetch or "refresh" any caller
  value. The issued snapshot is exactly the accepted request plus
  owner-computed amounts, numbering and validity.
- **D-3** No operation other than `POST /v2/quotes/{quoteId}/deliveries/email`
  can cause an email (or any other customer-facing message).
- **D-4** An issued snapshot and its document are immutable. Expiry and
  cancellation change the lifecycle state, never the snapshot or the bytes.
- **D-5** External correlation is provenance only; it is never quote identity
  and never idempotency identity.

## 2. Resources

| Resource | Identity | Notes |
|---|---|---|
| Quote | `quoteId` (UUID, owner) | Business identifier `quoteNumber` assigned at issue acceptance |
| Issuance operation | `operationId` (UUID, owner) | Created by issue acceptance; durable; `GET /v2/operations/{id}`. Separate lifecycle from the quote: an operator retry after a `failed` operation creates a new one for the same quote; `issuance.operationId` names the current one |
| Idempotency binding | `(principal, operation, key)` | Lookup `GET /v2/idempotency/current` |
| Delivery | `deliveryId` (UUID, owner) | Email only in 2.0 |
| Audit event | `eventId`, per-quote `sequence` | Append-only |

## 3. Lifecycle summary

States: `draft`, `issuing`, `issued`, `expired`, `cancelled` (full
specification: [QUOTE_V2_STATE_MACHINE.md](QUOTE_V2_STATE_MACHINE.md)).
`accepted` and `paid` do not exist in V2. Email delivery states are separate.
There is no public expire mutation.

## 4. Flows

### 4.1 Transactional flow — `POST /v2/quotes`

"Create and issue one formal quote from one frozen commercial snapshot."

One database transaction (the **acceptance transaction**):

1. binds the idempotency key (`quote.create_and_issue`) to the request fingerprint;
2. validates the request and verifies arithmetic, including `expectedTotals`;
3. authorizes `validityOverride` if present;
4. fixes the **issue effective instant** `issuedAt` and resolves validity (§7);
5. allocates the quote number (§8);
6. inserts the quote in `issuing`, its lines, shipping, validity, the
   issuance operation (`pending`) and the audit event `quote.issue.accepted`.

After commit the document is rendered under the operation lease
(§9, [recovery](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md)). The handler MAY render
inline for a bounded, server-configured budget (`syncIssueBudgetMs`). The
budget's value is an implementation parameter, **not an API invariant**: a
client MUST handle both outcomes below for every request and MUST NOT rely on
any particular synchronous wait (amendment A2).

- manifest committed within the budget → **`201`**, `quote.status = issued`;
- otherwise → **`202`**, `quote.status = issuing`, `Location:
  /v2/operations/{operationId}`; the worker continues.

Response body is always `QuoteOperationResult {quote, operation}`.

If validation, arithmetic, authorization or a dependency fails **before the
acceptance commit**, nothing is persisted and nothing is bound.

### 4.2 Manual flow

1. `POST /v2/quotes/drafts` → `201` draft (`quoteNumber = null`,
   `validity = null`, totals computed as preview, no document).
2. `PATCH /v2/quotes/{quoteId}/draft` with `expectedVersion` → `200`. Top-level
   member replacement: `externalCorrelation`, `customer`, `lines` (array
   replaced whole) and `shipping` (`null` removes). Omitted members unchanged.
3. `POST /v2/quotes/{quoteId}/issue` with `expectedVersion` → same acceptance
   transaction as §4.1 applied to the draft at that version; `200` when the
   quote is no longer `issuing`, `202` while `issuing`.

Drafts MAY have zero lines; issue requires ≥ 1 line (`422 validation_error`,
`details.fields[].code = "lines_required"`).

### 4.3 Response status as a function of state

Mutation responses — first execution and replay alike — are computed from the
**current** state of the bound resource:

| Operation | Status codes |
|---|---|
| `quote.create_and_issue` | `202` if `issuing`, else `201` |
| `quote.issue` | `202` if `issuing`, else `200` |
| `quote.draft.create` | `201` |
| `quote.draft.update`, `quote.cancel` | `200` |
| `quote.delivery.email` | `202` |

A replay additionally carries `Idempotent-Replay: true`. Consumers MUST NOT
use the status code alone as success evidence (§5).

## 5. Formal-quote success evidence

A customer-facing formal quote exists **only** when the owner representation
has all of:

- `status = "issued"`;
- `quoteId` and `quoteNumber` (non-null);
- `totals` (owner-computed);
- `issuance.issuedAt`;
- `validity` with `validThroughLocalDate` and `validUntilExclusive`;
- `document.available = true` and `document.pdfSha256` (non-null).

`issuing` is NOT evidence that a quote has been issued. A draft is NOT a
formal quote. `expired` and `cancelled` quotes are historical, not currently
valid offers. Consumers MUST NOT recompute final issued totals; they display
the owner's `totals` and line `amounts`.

## 6. Commercial snapshot and arithmetic

### 6.1 Representations

| Value | Representation |
|---|---|
| CLP amount (input) | JSON integer, whole pesos, 0 … 1 000 000 000 |
| CLP amount (computed) | JSON integer, 0 … 9 007 199 254 740 991 (larger results → `422 validation_error`) |
| Quantity | canonical decimal string, > 0, < 10 000, ≤ 6 fractional digits, no trailing fractional zeros (`"2"`, `"12.5"`, `"0.25"`) |
| Tax rate | canonical decimal string in (0, 1], ≤ 6 fractional digits (`"0.19"`) |
| Currency | `CLP` only in 2.0 |

Binary floating point MUST NOT be used for any contract value or in the
owner's arithmetic. Canonical decimal strings make the request fingerprint
unambiguous (`"1.5"` and `"1.50"` are not both accepted).

### 6.2 Charges

A **charge** is a line or the shipping charge. Each charge declares one input
basis: `unitPrice`/`amount` `{amount, taxBasis, taxRate?}`:

- `included`: `amount` is the tax-inclusive unit amount; `taxRate` required;
- `excluded`: `amount` is the net unit amount; `taxRate` required;
- `exempt`: `amount` is the unit amount; no tax; `taxRate` forbidden.

Quote does not decide which tax rate is legally correct; it verifies the
arithmetic of the declared basis.

### 6.3 Normative arithmetic

All operations use exact integers. Let `Q = quantity × 10⁶` and
`R = taxRate × 10⁶` (both exact integers by §6.1), `u` the unit amount, and
`halfUp(n, d) = floor((2n + d) / (2d))` for `n ≥ 0, d > 0`
(round half up, i.e. half away from zero for non-negative values).

```
extension = halfUp(u × Q, 10⁶)                      // rounded line extension

included:  gross = extension
           net   = halfUp(gross × 10⁶, 10⁶ + R)
           tax   = gross − net
excluded:  net   = extension
           tax   = halfUp(net × R, 10⁶)
           gross = net + tax
exempt:    net   = extension
           tax   = 0
           gross = net
```

Shipping is one charge with quantity `1`.

Totals (`totals`): `net = Σ net`, `tax = Σ tax`, `gross = Σ gross` over all
lines and shipping, and `exemptNet = Σ net` of exempt charges. Rounding happens
only at the charge boundary shown above; totals are sums of rounded values.
For every charge and for the totals `gross = net + tax`.

Worked example (from [examples/create-and-issue.request.json](examples/create-and-issue.request.json)):

| Charge | Input | net | tax | gross |
|---|---|---:|---:|---:|
| Mancuerna 10 kg ×2 | 24 990 included 0.19 | 42 000 | 7 980 | 49 980 |
| Banco plano ×1 | 89 990 included 0.19 | 75 622 | 14 368 | 89 990 |
| Shipping | 5 990 excluded 0.19 | 5 990 | 1 138 | 7 128 |
| **Totals** | | **123 612** | **23 486** | **147 098** |

`expectedTotals` (optional): if present, all of `net`, `tax`, `gross` MUST
equal the computed totals, otherwise `422 arithmetic_mismatch` with
`details.expected` and `details.computed`, and nothing is committed. This lets
a consumer bind the exact amounts a human approved.

### 6.4 Lines

`LineInput`:

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | `product` or `service` |
| `item.sourceSystem` | yes | Source identity of the item (e.g. the catalog owner's code) |
| `item.productRef`, `item.variantRef` | no | Opaque references where known; never parsed or resolved |
| `item.sku` | no | Where known |
| `item.description` | yes | Frozen customer-facing description (≤ 300) |
| `item.attributes[]` | no | Variant attributes `{name, value}` (≤ 10) |
| `quantity` | yes | `{value, unit}` |
| `unitPrice` | yes | §6.2 |
| `pricingProvenance` | no | `{sourceSystem, reference?, asOf}`; recorded, never verified |

1 to 100 lines on issue; 0 to 100 in a draft. Lines keep request order
(`position` 1…n). Callers MUST send the resolved amount of the exact selected
item and quantity tier; a "from" price is a caller defect Quote cannot detect.

### 6.5 Discounts and adjustments

2.0 has no discount, promotion or adjustment field and no discount engine.
Price reductions resolved by the caller are expressed in the unit amount.
Future caller-resolved adjustments, if a consumer needs them, are an additive
2.x request member (`adjustments[]`); because responses are open for
consumers (they MUST ignore unknown members) no placeholder is reserved now.

## 7. Validity

Owned by Quote. Default policy `cl-retail-5-calendar-days-v1`, issuer zone
`America/Santiago`: day 1 is the Chile civil date of `issuedAt`; valid through
the 5th civil date inclusive; `validUntilExclusive` is the first instant of the
6th civil date, resolved with the IANA tzdb; never N × 24 h. Frozen at issue
acceptance with `policyId` and `tzdbVersion`. Full specification:
[QUOTE_V2_VALIDITY_POLICY.md](QUOTE_V2_VALIDITY_POLICY.md).

Callers MUST NOT send `validUntil`. A principal with
`quotes:validity:override` MAY send
`validityOverride {validThroughLocalDate, reasonCode, note?}`.

## 8. Quote number

- Allocated by the owner **inside the acceptance transaction** (never for a
  draft, never on replay).
- Format `<PREFIX>-<sequence>`: `PREFIX` from the issuer profile (`PC` for
  `pesaschile-cl-v1`), sequence from PostgreSQL `quote_number_seq` (bigint),
  left-padded to **at least** 6 digits and never truncated
  (`PC-000137`, `PC-999999`, `PC-1000000`).
- Unique (database constraint). Gaps are permitted (rolled-back acceptance;
  a number whose quote was cancelled after a failed issuance never appears on
  a document).
- Consumers MUST treat it as opaque and MUST NOT construct it.
- V2 continues the V1 sequence; V1 numbers are never reused.

## 9. Document

### 9.1 Content

The issued document (PDF) MUST contain:

- issuer identity from the issuer profile;
- `quoteNumber`; issue date (Chile civil date of `issuedAt`);
- "Válida hasta el DD/MM/AAAA inclusive (hora de Chile)" from
  `validThroughLocalDate` (or the override equivalent);
- the customer snapshot as given (absent fields omitted; a guest without data
  shows "Cliente: no informado", never fabricated values);
- every line: description, SKU if present, variant attributes, quantity and
  unit, unit amount with its tax basis, line net/tax/gross;
- shipping when present: carrier name, service type name when present,
  destination commune/region, amounts; when absent: "Despacho no incluido";
- totals: net, exempt net when non-zero, tax, gross;
- a global "valores con IVA incluido" statement **only if** every charge has
  `taxBasis = included`; otherwise per-charge basis labels only.

The document never contains internal ids beyond `quoteNumber`, nor
`externalCorrelation`, item references or provenance.

### 9.2 Manifest (persisted, returned in `document`)

`semanticSnapshotHash` (SHA-256 of RFC 8785 JCS of the issued snapshot:
`quoteId, quoteNumber, currency, issuerProfileId, issuedAt, validity,
customer, lines with amounts, shipping with amounts, totals`), `pdfSha256`,
`byteLength`, `rendererVersion`, `templateVersion`, `generatedAt`,
`artifactRef = "sha256:<pdfSha256>"`.

### 9.3 Rules

- Rendered only after acceptance, from the frozen snapshot; never from live
  configuration other than the renderer/template versions recorded in the
  manifest.
- The renderer SHOULD be byte-deterministic for a given
  `(snapshot, rendererVersion, templateVersion)` (fixed PDF metadata dates
  from `issuedAt`, no random identifiers). Correctness does not depend on it:
  the first committed manifest wins.
- `GET /v2/quotes/{quoteId}/document` streams exactly the stored bytes after
  verifying `pdfSha256`; never re-renders. Mismatch or missing file →
  `503 document_storage_failed` and an operator incident.
- Repair of a lost artifact is an operator procedure that MUST reproduce the
  recorded `pdfSha256`; otherwise the artifact stays unavailable. Bytes are
  never silently replaced.
- No public HTML artifact in V2.

### 9.4 Storage

Persistent single-host filesystem with backup/restore; content-addressed
immutable layout (`<root>/artifacts/sha256/<aa>/<bb>/<pdfSha256>.pdf`), write
to temporary file, fsync, atomic rename, re-read hash verification. No object
storage in this phase. A periodic integrity check verifies every manifest's
file hash.

## 10. Email delivery (optional subsystem)

### 10.1 Separation

Issuance never sends email. `POST /v2/quotes/{quoteId}/deliveries/email` is
the only trigger. For the initial production configuration the email provider
is **disabled**: the endpoint returns `503 dependency_unavailable`
(`details.dependency = "email_provider"`) and queues nothing.

### 10.2 Semantics (when enabled)

- Allowed only while `status = issued` (`409 invalid_state_transition`
  otherwise).
- Recipient: `recipient.email`, else `customer.email`, else
  `422 delivery_recipient_missing`.
- Queue row, outbox row, recipient snapshot, pinned `documentSha256` and audit
  event are written in one transaction; idempotent per key.
- Delivery states: `pending → sending → sent | failed | unknown`. A send whose
  provider acceptance is ambiguous becomes `unknown` and is NOT blindly
  retried. Only failures known not to have been accepted are retried.
- Delivery outcome never changes the quote state or document.
- Gmail is one provider adapter behind a generic mail port.

## 11. Audit

Append-only per quote, ordered by `sequence`. Event types (`openapi.yaml`
`AuditEventType`): draft created/updated, issue accepted, issue attempt
failed, issued, issue failed, cancelled, expired, delivery
requested/sent/failed/unknown, idempotency replayed/conflict, legacy V1 event.

Each event records the authenticated `principalId` (or `system`), operation,
`correlationId` (the producing request's `X-Correlation-Id`, request/trace
correlation only), `idempotencyKeyHash` (SHA-256; never the raw key), from/to
status and minimal non-PII data (counts, totals, versions, codes). Customer
PII, recipient addresses and line payloads are never placed in audit data or
logs.

## 12. Errors

Envelope: `{"error": {"code", "message", "requestId", "details"?}}`. Messages
are human text and not part of the contract; `code` is. Never raw PostgreSQL,
Gmail, filesystem or stack details.

| Code | HTTP | When | `details` |
|---|---|---|---|
| `invalid_request` | 400 | Malformed JSON, missing/invalid `Idempotency-Key`, bad path/query parameter, unsupported media type | `fields[]` optional |
| `unauthenticated` | 401 | Missing/invalid credential | — |
| `forbidden` | 403 | Missing scope (including `validityOverride` without override scope) | `requiredScope` |
| `quote_not_found` | 404 | Unknown or not visible to the principal | — |
| `operation_not_found` | 404 | Unknown or not visible | — |
| `delivery_not_found` | 404 | Unknown or not visible | — |
| `invalid_state_transition` | 409 | Operation not allowed from current state | `status` |
| `version_conflict` | 409 | `expectedVersion` ≠ current | `expectedVersion`, `currentVersion` |
| `idempotency_key_conflict` | 409 | Same principal + operation + key, different fingerprint | `operation`, `boundRequestFingerprint` |
| `operation_in_progress` | 409 | Target quote is `issuing` (cancel, draft update, second issue) | `operationId` |
| `document_not_available` | 409 | Document read for a quote that never reached `issued` | `status` |
| `api_version_retired` | 410 | Any `/v1/*` route after cutover | — |
| `payload_too_large` | 413 | Body over limit (1 MiB) | — |
| `validation_error` | 422 | Schema or semantic validation (unknown member, RUT check digit, empty lines on issue, override date out of range, amount overflow) | `fields[] {path, code, message}` |
| `arithmetic_mismatch` | 422 | `expectedTotals` ≠ computed | `expected`, `computed` |
| `delivery_recipient_missing` | 422 | No recipient email available | — |
| `internal_error` | 500 | Unexpected; sanitized | — |
| `dependency_unavailable` | 503 | DB/storage/renderer/email provider unavailable before any commit | `dependency`, `retryable` |
| `schema_not_ready` | 503 | Database schema not at expected head | — |
| `document_storage_failed` | 503 | Stored artifact missing/corrupt on document read | — |
| `document_generation_failed` | — | Only as `operation.attempts.lastErrorCode` | — |

Evaluation order for a mutation: `413 / 400` (size, JSON, headers,
parameters) → `401` → `403` (scopes, including the override scope when
`validityOverride` is present) → **idempotency binding lookup** (bound + same
fingerprint → replay; bound + different fingerprint → `409
idempotency_key_conflict`) → `404` → `422` → `409` state/version → acceptance.
`503` can occur at any step that needs a dependency. Because the binding is
checked before resource, semantic and state checks, a retried request whose
first attempt committed always receives the bound result. A 4xx or 503 never
binds a key.

## 13. Health

| Route | Auth | Contract |
|---|---|---|
| `GET /health/live` | none | `200 {"status":"live"}` whenever the process answers HTTP; no dependency probe |
| `GET /health/ready` | none | `200` only if database reachable, schema at expected head, artifact storage writable+readable, renderer ready and not shutting down; else `503`; body has only `ok`/`fail` per check |
| `GET /health/dependencies` | `service:health:dependencies` | Sanitized per-dependency status, failure category, last success; worker poll/queue metrics; expected vs actual schema head. Never hostnames, DSNs, stacks or secrets |

A database outage MUST NOT crash or restart-loop the process: liveness stays
`200`, readiness `503`, business routes `503 dependency_unavailable` /
`schema_not_ready`, connections retried with bounded backoff. The process MAY
exit only for invalid static configuration. Supervisor restarts are not a
recovery mechanism.

## 14. Correlation

Two distinct concepts (amendment A3):

- **Durable business correlation** — `externalCorrelation {sourceSystem,
  externalReferenceType?, externalReference?}` is required on create and
  stored on the quote. `externalReferenceType` and `externalReference` are
  given together. Several quotes may share a reference.
  `GET /v2/quotes?sourceSystem=…` lists them. It is part of the request body
  and therefore of the fingerprint.
- **Request/trace correlation** — the optional `X-Correlation-Id` header. It
  identifies one HTTP request for tracing, is recorded on the audit events
  and logs that request produces, and is never stored on the quote, never
  part of the fingerprint and never quote or idempotency identity.

## 15. Customer snapshot

`customer` is one of:

| kind | Required | Optional |
|---|---|---|
| `guest` | — | `displayName`, `email`, `phone`, `address`, `externalCustomerReference` |
| `person` | `displayName` | `rut`, `email`, `phone`, `address`, `externalCustomerReference` |
| `company` | `legalName` | `tradeName`, `rut`, `contactName`, `email`, `phone`, `address`, `externalCustomerReference` |

No CRM identity is required. Email and phone are never required to issue.
`rut`: no dots, uppercase `K`, check digit verified (syntax only, not identity
verification). `address {lines?, commune?, region?, country: "CL"}` is a
contact/billing address and is independent of the shipping destination.
Nothing is fabricated for absent fields. Example payloads:
[guest](examples/customer.guest.json),
[guest with contact](examples/customer.guest-with-contact.json),
[person](examples/customer.person.json),
[company](examples/customer.company.json).

## 16. Shipping snapshot

```
shipping {
  carrier      { code?, name }
  serviceType? { code?, name? }        // at least one member when present
  destination  { commune, region?, country: "CL" }
  amount       { amount: integer CLP, taxBasis: included|excluded|exempt, taxRate? }
  sourceQuote? { sourceSystem, reference?, asOf }
}
```

At most one shipping charge, quantity 1. Response adds `amounts {net, tax,
gross}`. Quote never calls a shipping owner, never re-rates, never chooses or
infers a carrier or service. A source that prices freight net (e.g. a carrier
service returning net CLP) is sent as `taxBasis = excluded, taxRate = "0.19"`.
Examples: [input](examples/shipping.input.json),
[stored snapshot](examples/shipping.snapshot.json).

## 17. Approval and price-freeze semantics (consumer obligations)

Quote has no notion of approval and no current-price lookup. A consumer that
requires human approval MUST:

1. build the exact request body (lines, shipping, customer, correlation,
   `expectedTotals`) from its own evidence;
2. obtain approval of exactly that body;
3. send exactly that body, byte-for-byte semantically, under one idempotency
   key — on the first attempt and on every retry.

No operation of this contract requires or permits Quote to re-price.
Re-fetching prices after approval and sending different values is a consumer
defect; with `expectedTotals` set, a changed total is rejected
(`arithmetic_mismatch`) and a changed body under the same key is rejected
(`idempotency_key_conflict`). Approval expiry, if a business needs it, is the
consumer's policy, not Quote's.

## 18. Versioning

`/v2` is the only supported API. Request schemas are closed. Additive response
members and additive optional request members are 2.x changes; anything else
is `/v3`. Enumerations in responses MAY gain values only in a documented 2.x
release; consumers MUST treat an unknown `status` as "not issued".
