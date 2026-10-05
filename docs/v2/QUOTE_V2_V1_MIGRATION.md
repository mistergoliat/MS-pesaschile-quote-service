# Quote Service V1 → V2 Migration Mapping and KEEP / CHANGE / DELETE

Status: **FROZEN (R1.2)**. Normative for data mapping. V1 baseline: `fade75d`
(migrations `000001`–`000005`, routes in `src/http/routes/quote-route.ts`).

Principles: preserve data, not the V1 contract. One forward migration; no
dual API, no compatibility shim, no dual writes. Production rule: backup and
verified restore before migrating; never run `down` in production.

Known state (J3A owner audit, read-only observation 2026-10-04): the production
instance never had a reachable database and served one read. The data
inventory step (R1.7) MUST still check the database and its backups and the
document root before declaring "no V1 data"; this mapping applies to whatever
is found.

"Legacy data" below means an internal, append-only `legacy_v1` record per
migrated quote (jsonb, owner-internal). It is not part of the V2 API, is never
rendered and is readable only through database-level operator access.

## 1. Field mapping

### 1.1 `quote_service.quotes`

| V1 column / field | V2 target | Rule |
|---|---|---|
| `quote_id` | `quoteId` | Unchanged |
| `quote_number` | `quoteNumber` | Kept for rows with V1 status ≠ `draft`. For V1 `draft` rows: V2 `quoteNumber = null`; the V1 number is kept in legacy data (`legacy.v1QuoteNumber`) and is never reused |
| `quote_number_seq` | `quote_number_seq` (bigint) | Kept; V2 continues from its current value. Formatting changes from `lpad(…, 6)` (truncating) to "at least 6 digits" |
| `opportunity_id` (NOT NULL) | `externalCorrelation.externalReferenceType = "opportunity"`, `externalReference = opportunity_id` | Column removed from the required model. `sourceSystem` from `source_system` (`crm_customer_360` kept verbatim; `manual`/`api`/`scheduler` → `legacy-v1`) |
| `customer_id` | `customer.externalCustomerReference {sourceSystem, reference}` | `sourceSystem` as above |
| `conversation_id` | legacy data `legacy.conversationId` | Not part of the V2 model (only one external reference per quote) |
| `actor_type`, `actor_id` | `createdByPrincipalId = "legacy-v1"`; original values in legacy data | V1 actor was a request claim, not an authenticated principal |
| `source_system`, `source_correlation_id` | `externalCorrelation.sourceSystem` (see above); `source_correlation_id` → legacy data `legacy.sourceCorrelationId` | `source_correlation_id` was request/trace correlation, not durable business correlation (amendment A3) |
| `status` | `status` | `draft`→`draft`; `issued`→`issued` (projected `expired` if past validity); `accepted`→`issued` + legacy event; `paid`→`issued` + legacy events (accepted, paid); `cancelled`→`cancelled`; `expired`→`expired` |
| `accepted_at`, `paid_at` | audit `legacy.v1.event` (`data.action = accepted / paid`) | Historical facts preserved; Quote does not claim payment truth |
| `currency` | `currency` | `CLP` |
| `customer_snapshot` jsonb `{name, businessName, email, phone, address, district, region}` | `customer` | `businessName` present → `company {legalName: businessName, contactName: name}`; else `person {displayName: name}`. `email`, `phone` copied when valid (invalid → legacy data). `address` → `address.lines[0]`, `district` → `address.commune`, `region` → `address.region`, `country = "CL"`; address omitted if neither line nor commune |
| `subtotal`, `tax_amount`, `total` | `totals.net`, `totals.tax`, `totals.gross`; `exemptNet` computed | Must re-verify with V2 arithmetic; mismatch → migration exception (row not migrated silently) |
| `valid_until` | `validity {source: "legacy_caller_supplied", policyId: null, tzdbVersion: null, issuerZone: "America/Santiago", issueLocalDate: civilDate(issued_at), validThroughLocalDate: civilDate(valid_until − 1 µs), validUntilExclusive: valid_until, override: null}` | Non-draft rows only; drafts drop validity (resolved at V2 issue). Never recalculated under the V2 policy |
| `version` | `version` | Unchanged |
| `revision_root_id`, `previous_revision_id`, `supersedes_quote_id`, `superseded_by_quote_id` | legacy data `legacy.revision` | V2 has no revisions |
| `issued_content_hash` | `document.semanticSnapshotHash` | Marked legacy algorithm (`legacy.hashAlgorithm = "v1-canonical-json"`); not recomputed |
| `issued_render_version` | `document.rendererVersion` | `templateVersion = "v1-legacy"` |
| `issued_pdf_storage_key`, `issued_pdf_sha256` | `document.pdfSha256`, `artifactRef`; file moved/copied to the content-addressed layout | Bytes unchanged; hash verified; missing file → migration exception, `document.available = false` is NOT set silently |
| `issued_html_storage_key`, `issued_html_sha256` | retained in storage + legacy data | No public HTML artifact in V2 |
| `issued_document_generated_at` | `document.generatedAt` | — |
| `created_at`, `updated_at`, `issued_at`, `cancelled_at`, `expired_at` | `createdAt`, `updatedAt`, `issuance.issuedAt`, `cancellation.cancelledAt` (`reasonCode = "legacy_v1"`, `initiatedBy = "legacy-v1"`), `expiration.expiredAt` | V2 rule `expiredAt = validUntilExclusive` applies to newly materialized expiries only; V1 `expired_at` kept as recorded |
| — | `issuance.operationId` | Synthetic `succeeded` operation per issued V1 quote (`attempts.count = 0`) |
| — | `issuance.issuerProfileId` | `pesaschile-cl-v1` |

### 1.2 `quote_service.quote_lines`

| V1 | V2 | Rule |
|---|---|---|
| `line_id`, `display_order` | `lineId`, `position = display_order + 1` | — |
| `type = product / service` | `kind` | Unchanged |
| `type = shipping` | `kind = "service"` line, `item.sourceSystem = "legacy-v1-shipping"` | V1 shipping lines carry no carrier/destination; nothing is fabricated into the V2 `shipping` snapshot. Historical amounts and PDF unchanged |
| `external_source` | `item.sourceSystem` | null → `legacy-v1` |
| `external_item_id`, `external_variant_id`, `sku` | `item.productRef`, `item.variantRef`, `item.sku` | — |
| `description` | `item.description` | Over 300 chars → migration exception |
| `quantity` numeric(20,6) | `quantity {value: canonical decimal string, unit: "unit"}` | Canonicalized (no trailing zeros) |
| `unit_price`, `tax_included`, `tax_rate` | `unitPrice {amount, taxBasis, taxRate}` | `tax_rate = 0` → `exempt` (no rate); else `included`/`excluded` with the rate |
| `line_subtotal`, `line_tax`, `line_total` | `amounts.net/tax/gross` | Re-verified with V2 arithmetic |

### 1.3 Other tables

| V1 | V2 | Rule |
|---|---|---|
| `idempotency_keys` (`(key, operation_name)`, raw key, response snapshot) | bindings with `principal_id = "legacy-v1"`, `key_hash = SHA-256(key)` | Raw keys and response snapshots are not migrated; `in_progress`/`failed` rows dropped (they bound nothing durable) |
| `quote_audit_events` | audit `legacy.v1.event` with `data.action` = V1 action | Order preserved by `event_at`, then id |
| `quote_deliveries` | deliveries | `sent`→`sent`, `failed`→`failed`, `processing`→`unknown`, `pending`→`failed` (`lastErrorCode = superseded_by_v2_migration`) so no stale email is ever sent after migration |
| `quote_email_outbox` | not migrated | Delivery state above is authoritative |

## 2. KEEP / CHANGE / DELETE

### KEEP

- Model B: caller-frozen commercial snapshot, owner arithmetic (CLP half-up,
  integer pesos, decimal quantities/rates) — `src/domain/money.ts`,
  `src/domain/quote-line.ts`, `src/domain/quote-pricing.ts`.
- Owner-generated `quoteId` (UUID) and owner sequence `quote_number_seq` with
  unique constraint.
- Durable states `draft`, `issued`, `expired`, `cancelled`; optimistic
  `expectedVersion` fencing.
- Canonical-JSON request hashing for idempotency; atomic binding + effect for
  create.
- Immutable, hash-identified issued document; native in-process PDF renderer
  (pdfmake); content-addressed filesystem storage with backup.
- Append-only audit events.
- Email delivery subsystem as a separate, explicit, outbox-based operation;
  Gmail as one provider adapter.
- Fastify + zod boundary validation, structured logging, explicit migration
  command, zod-validated configuration.

### CHANGE

- Create: transactional `POST /v2/quotes` = create **and** issue; drafts via
  `POST /v2/quotes/drafts`; draft edit via `PATCH` (top-level replacement).
- Quote number: allocated at issue acceptance, not at draft; never truncated.
- Issue: durable `issuing` state + leased, fenced issuance operation; artifact
  written before manifest commit; manifest commit before success response;
  `201/200` vs `202`.
- Validity: owner policy `cl-retail-5-calendar-days-v1` in `America/Santiago`;
  privileged override only; frozen at issue.
- Correlation: generic `externalCorrelation` replaces `opportunityId`,
  `conversationId`, `source.system` enum.
- Customer: `guest | person | company` snapshot; RUT optional; no required
  name for guests.
- Lines: structured item snapshot (`sourceSystem`, refs, SKU, description,
  attributes), quantity with unit, explicit `taxBasis included|excluded|exempt`,
  optional pricing provenance, optional `expectedTotals`.
- Shipping: structured snapshot (carrier, service type, destination, amount
  basis, source quote) instead of a generic `shipping` line.
- Idempotency: scope `(principal, operation, key)`, key hashed, binding
  retained for the quote's lifetime, direct lookup endpoint, replay returns
  current state.
- Authentication: per-principal credentials and scopes; visibility rule.
- Document: Chile-local dates, validity-through inclusive date, per-charge tax
  basis labels, shipping details, manifest with snapshot hash, PDF hash,
  renderer and template versions.
- Health: `/health/live`, `/health/ready` (incl. schema head),
  `/health/dependencies`; no crash on database outage.
- Errors: one typed code catalog; `422` for semantic validation.

### DELETE

- All `/v1/*` routes (after cutover they answer `410 api_version_retired`):
  `POST /v1/quotes`, `PUT /v1/quotes/:id/draft`, `POST …/issue`,
  `POST …/accept`, `POST …/mark-paid`, `POST …/cancel`, `POST …/expire`,
  `POST …/revisions`, `GET /v1/quotes`, `GET …/by-number/:n`,
  `GET …/:id`, `GET …/:id/documents`, `GET /v1/documents/:documentRef`,
  `GET …/audit`, `POST …/send-email`, `GET …/deliveries…`.
- Quote statuses `accepted` and `paid`; `mark-paid`; payment semantics.
- Public expire mutation.
- Revisions / supersession endpoints and fields.
- Required `opportunityId`; caller-supplied `validUntil`; caller `actor` and
  `source.system` enum as authority.
- Single global `SERVICE_AUTH_TOKEN`.
- Public HTML artifact and HMAC `documentRef` download tokens.
- Hard-coded "5 días" policy text and global "Precios incluyen IVA" note in
  templates.
- `idempotency_keys.response_body_snapshot` replay and the stuck
  `in_progress` issue claim.
- Startup validation that exits the process when the database is unreachable.
