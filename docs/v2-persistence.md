# Quote Service — V2 Persistence and Migration (R1.4)

Status: implemented in R1.4. This document explains **how** the persistence
layer implements the frozen contract in [`docs/v2/`](v2/README.md). The
contract defines **what**. If the two disagree, the contract wins and this
document is wrong.

Scope of R1.4: schema, forward migrations, migration integrity, privilege
separation and the V1 → V2 data migration. It contains no V2 HTTP routes, no
issuance execution, no number allocation, no validity computation and no
workers. Those start in R1.5 (§9).

---

## 1. Contract amendments applied first

Before any implementation, three contradictions with final R1.2 decisions
were corrected in the contract. They are recorded as A1–A3 in
[the freeze record](v2/QUOTE_V2_CONTRACT_FREEZE.md#3a-contract-amendments-r14),
and the static validator (446/446 checks) pins all three.

| # | Amendment | Effect on persistence |
|---|---|---|
| A1 | Quote and issuance-operation lifecycles are separate. A deadline failure fails the **operation**, never the quote. The quote stays `issuing` until an operator retry (new operation) or a principal cancel. | Several operations per quote; at most one active and at most one succeeded. `quotes.current_operation_id` names the latest one. Retry lineage is recorded. |
| A2 | `201`/`202` semantics are frozen, but the synchronous wait (`syncIssueBudgetMs`) is not an API invariant | None (runtime configuration, R1.5) |
| A3 | Request/trace correlation (`X-Correlation-Id`) is distinct from durable `externalCorrelation` | The quote stores only `source_system`, `external_reference_type` and `external_reference`. Trace correlation lives on audit events. V1 `source_correlation_id` goes to legacy evidence. |

## 2. Migration inventory and schema head

| Migration | Purpose | Reversible |
|---|---|---|
| `000001`–`000005` | V1 schema (unchanged, historical) | yes (local only) |
| `000006_migration_integrity` | `schema_migration_checksums` table; `reject_mutation()` trigger function | yes (local only) |
| `000007_quote_v2_persistence` | V2 schema plus the one-way V1 → V2 data migration; integrity triggers | **no** (`down = false`) |
| `000008_quote_v2_runtime_grants` | `apply_runtime_grants()` and runtime privilege grants | yes (local only) |
| `000009_quote_snapshot_child_insert_guard` | **R1.4 erratum (found in R1.5A.3):** `quote_lines` / `quote_shipping` INSERT allowed only while the parent quote is `draft` (000007 guarded only UPDATE/DELETE) | yes (local only) |

**Expected head:** `000009_quote_snapshot_child_insert_guard`.

All pending migrations run in **one transaction**. The migrator sets
`singleTransaction: true` explicitly, because node-pg-migrate's programmatic
runner does not default it. A failed data migration therefore never leaves a
partial head behind.

### Schema-head update procedure (for every future migration)

1. Add `src/infrastructure/persistence/postgres/migrations/NNNNNN_name.cjs`.
   Never edit an existing migration file.
2. Run `npm run db:manifest`. This regenerates `migration-manifest.ts`
   (names plus SHA-256), whose last entry *is* `EXPECTED_SCHEMA_HEAD`.
3. Commit both together. The unit test "the compiled manifest matches the
   packaged migration files" fails if step 2 was skipped.
4. Runtime readiness reports `schema_not_ready` (`SCHEMA_BEHIND`) until the
   database is migrated. The server never migrates by itself.

## 3. Migration integrity

| Layer | Check | On failure |
|---|---|---|
| Build / startup | Packaged `*.cjs` files equal the compiled manifest: same names, order and checksums | Process refuses to start (`runtime.init_failed`). `db:migrate` and `db:check` refuse to run |
| Before migrating | Every checksum already recorded in the database equals the packaged file of the same name | `MigrationIntegrityError`; nothing runs |
| After migrating | A checksum row is recorded for every applied migration: `applied` (this run) or `backfilled` (applied before tracking existed, e.g. `000001`–`000005` on a V1 database) | — |
| Runtime readiness | At head **and** every applied migration has a matching recorded checksum | `SCHEMA_INTEGRITY_MISMATCH` (changed bytes) or `SCHEMA_INTEGRITY_UNVERIFIED` (missing record): `schema: fail`, `503 schema_not_ready`, `database: degraded / integrity` in `/health/dependencies` |

- **Checksum:** SHA-256 of the file content with CRLF normalized to LF, so
  Windows (autocrlf) and Linux checkouts agree. Verified against git's LF
  blob.
- **Storage:** `quote_service.schema_migration_checksums` is Quote-owned and
  append-only (trigger). node-pg-migrate's `schema_migrations` is only
  **read** (`name`, `id`), never modified. No internals are patched.
- **Limitation:** checksums are recorded right after the migration
  transaction commits. A crash in between leaves `UNVERIFIED`, which fails
  closed. Re-running `db:migrate` records the missing checksums as
  `backfilled`.

## 4. Target persistence model (`quote_service`)

| Table | Holds | Key invariants (database-enforced) |
|---|---|---|
| `quotes` | Quote lifecycle, durable correlation, customer snapshot (jsonb), owner totals, issuance, validity snapshot, cancellation, expiration | Status ∈ `draft, issuing, issued, expired, cancelled`. Issue acceptance is atomic (number, issuance and validity are all null or all set). Draft ⇒ no number. Number unique when present, `^[A-Z]{2,8}-[0-9]{6,}$` (never truncated). Validity source shape (`policy`, `override`, `legacy_caller_supplied`). `gross = net + tax`, ≤ 2⁵³−1. External reference type/value come as a pair |
| `quote_lines` | Caller-frozen commercial line snapshot (Model B) | Position 1..100, unique per quote. Exact `numeric(10,6)` quantity in (0, 10000). Whole-CLP `bigint` unit amount ≤ 10⁹. `numeric(7,6)` tax rate in (0, 1], absent iff `exempt`. `gross = net + tax`, exempt ⇒ tax 0 |
| `quote_shipping` | Structured shipping snapshot (0..1 per quote) | Carrier name, commune, `country = 'CL'`, same charge rules as lines, source-quote provenance shape |
| `issuance_operations` | Durable issuance operation: status, fencing generation, lease, attempts, retry timing, deadline, error code, snapshot identity, origin, retry lineage | One active (`pending`/`running`) and one `succeeded` per quote (partial unique indexes). Running ⇔ lease set. Terminal ⇔ `completed_at`. Failed ⇒ error code. Pending ⇒ `next_attempt_at`. `deadline_at > accepted_at`. `generation ≥ attempt_count`. Operator retry ⇔ `retry_of_operation_id` |
| `quote_documents` | Immutable manifest: snapshot hash and algorithm, PDF SHA-256, byte length, renderer/template versions, `generated_at`, `artifact_ref` (generated `sha256:<hash>`), `storage_key` | One per quote. FK `(operation_id, quote_id)`. New artifacts must use the content-addressed key `artifacts/sha256/aa/bb/<sha>.pdf` |
| `quote_audit_events` | Append-only audit | Unique `(quote_id, sequence)`. Event type from the contract enum. Principal `SystemCode`. Request trace `correlation_id`. `idempotency_key_hash` (hash only) |
| `idempotency_bindings` | Scope `(principal_id, operation, key_hash)`, fingerprint, immutable request snapshot, resource refs, `bound_at` | PK on the scope. V2 shape: contract operation names, snapshot required, `operation_id` required for issue operations, never `legacy-v1`. Legacy shape: `legacy-v1` principal, `legacy.v1.*` operation, no snapshot |
| `quote_deliveries` | Email deliveries (queue state on the row) | Sent ⇔ `sent_at`. Failed ⇒ code. Sending ⇔ lease. Pending ⇒ schedule. Pinned `document_sha256` |
| `quote_legacy_v1` | One append-only legacy-evidence record per migrated quote | No runtime grant |
| `schema_migration_checksums` | Migration integrity (§3) | Append-only |
| `quote_number_seq` | Number sequence (bigint) | Never reset; V2 continues from the V1 value |

### Triggers (installed after the data migration)

- `quotes_guard`: allowed transitions only (`draft→draft|issuing|cancelled`,
  `issuing→issuing|issued|cancelled`, `issued→issued|cancelled|expired`;
  `expired`/`cancelled` are terminal). Identity and version are monotonic.
  After `draft`, the number, customer, correlation, totals, issuance and
  validity are frozen (D-4). Quotes are never deleted.
- `quotes_require_document` (deferred constraint trigger): `issued`/`expired`
  requires a committed manifest at commit time.
- `quote_lines_guard`, `quote_shipping_guard`: UPDATE/DELETE only while the
  quote is `draft`.
- `issuance_operations_guard`: terminal operations are immutable; identity is
  immutable; `generation` and `attempt_count` never decrease; never deleted.
- `quote_documents_guard`: immutable. The single exception is recording the
  verified `byte_length` of a legacy artifact once.
- Append-only: `quote_audit_events`, `idempotency_bindings`,
  `quote_legacy_v1`, `schema_migration_checksums`.

### Indexes (each maps to a contract query or worker step)

| Index | Access pattern |
|---|---|
| `quotes_quote_number_unique` | Number uniqueness |
| `quotes_external_correlation_idx (source_system, external_reference_type, external_reference, created_at desc, quote_id desc)` | `GET /v2/quotes?sourceSystem&externalReferenceType&externalReference` |
| `quotes_issued_validity_idx (valid_until_exclusive) where status='issued'` | Expiry materialization job |
| `quote_lines_position_unique` | Line order per quote |
| `issuance_operations_one_active_per_quote`, `…_one_succeeded_per_quote` | A1 invariants; current active operation lookup |
| `issuance_operations_pending_due_idx`, `…_running_lease_idx`, `…_active_deadline_idx` | Claim, lease reclaim, deadline sweep (Idempotency §4.3) |
| `quote_documents_quote_unique` | Document read by quote |
| `quote_audit_events_sequence_unique` | Audit paging |
| `idempotency_bindings_pkey` | Binding lookup / replay / conflict |
| `quote_deliveries_quote_idx`, `…_pending_due_idx`, `…_sending_lease_idx` | Cancel-time delivery sweep (T8), delivery worker claim and reclaim |

## 5. V1 → V2 data mapping as implemented

The frozen mapping is [QUOTE_V2_V1_MIGRATION.md](v2/QUOTE_V2_V1_MIGRATION.md).
`000007` implements it in one transaction:

1. stage the V1 rows;
2. validate every row and collect exceptions;
3. drop the V1 tables (no shadow tables, no dual write);
4. create the V2 schema;
5. transform;
6. verify post-conditions;
7. install triggers.

Output is deterministic: every derived id is `md5('<purpose>:' || v1_id)::uuid`.
The only run-dependent values are `migrated_at` and the checksum timestamps.

| V1 | V2 | Notes |
|---|---|---|
| `quote_id`, `version`, `created_at`, `updated_at` | same | Preserved |
| status `draft` | `draft`, number null | V1 number → `legacy.v1QuoteNumber` (never reused) |
| status `issued` / `accepted` / `paid` | `issued` | Not re-projected to `expired` (projection is a read concern). `accepted_at`/`paid_at` become `legacy.v1.event` audit events, derived from the columns when V1 had no such event; Quote claims no payment authority |
| status `cancelled` | `cancelled` (`legacy_v1`, initiated by `legacy-v1`) | Keeps its number only if it was issued (`issued_at` set). A cancelled draft has no number (OpenAPI `Quote.quoteNumber`) |
| status `expired` | `expired`, `expired_at` as recorded | Not snapped to `validUntilExclusive` (contract exception for migrated quotes) |
| `opportunity_id` | `external_reference_type = 'opportunity'`, `external_reference = value` | `source_system`: `crm_customer_360` kept; `manual/api/scheduler` → `legacy-v1`. The value is never discarded; several quotes may share it |
| `customer_id` | `customer.externalCustomerReference` | Invalid → legacy evidence |
| `conversation_id`, `source_correlation_id`, actor, revision links | `quote_legacy_v1.data.legacy` | Not V2 concepts |
| `customer_snapshot` | `company {legalName, contactName}` if `businessName`, else `person {displayName}`; email/phone only if valid; `address.lines[0]` / `commune` / `region`, `country CL` | Invalid email/phone → `legacy.invalidCustomerFields`. Nothing fabricated |
| `valid_until` (issued quotes) | validity `legacy_caller_supplied`, `America/Santiago`, no policy/tzdb; issue date = civil date of `issued_at`; through date = civil date of `valid_until − 1 µs`; `validUntilExclusive = valid_until` | Never recomputed under the V2 policy. Drafts have no validity |
| lines `product`/`service` | same kind; `item_source_system = external_source` or `legacy-v1`; refs and SKU kept; `quantity_unit = 'unit'`; `tax_rate = 0` → `exempt`, else `included`/`excluded` | Amounts **re-verified** with V2 integer arithmetic; any mismatch is an exception |
| lines `shipping` | `service` line, `item_source_system = 'legacy-v1-shipping'`, amounts kept | **No** `quote_shipping` row: carrier, destination and service type are never inferred from text. Ids listed in `legacy.shippingLineIds` |
| issued document columns | `quote_documents` (`origin legacy_v1`, algorithm `v1-canonical-json`, template `v1-legacy`, V1 storage key kept, `byte_length` null until verified) | Bytes untouched, never regenerated. HTML artifact → legacy evidence |
| — | one synthetic `succeeded` operation per issued quote (`origin legacy_v1_migration`, 0 attempts) | Frozen mapping |
| `idempotency_keys` `completed` | typed legacy binding (`legacy-v1`, `legacy.v1.<op>`, `SHA-256(key)`, V1 request hash) | Raw keys and response snapshots are **not** migrated. `in_progress`/`failed` rows bound nothing durable and are dropped (frozen mapping) |
| `quote_audit_events` | `legacy.v1.event`, order `(event_at, id)`, data = action and V1 statuses | Raw key → hash. Payload snapshots (PII) only in legacy evidence |
| deliveries `sent` / `failed` / `processing` / `pending` | `sent` / `failed` / `unknown` / **`failed` with `superseded_by_v2_migration`** | Nothing queued in V1 can be sent after cutover. `quote_email_outbox` is not migrated |

### Migration exceptions

Any row that violates the frozen mapping aborts the whole migration. The
transaction rolls back and the database stays V1. The error lists up to 100
exceptions as `<quote_id> <code> <detail>`, with ids and codes only, never
customer data:

`issued_without_issued_at`, `document_missing`, `document_metadata_invalid`,
`cancelled_without_cancelled_at`, `expired_without_expired_at`,
`validity_not_after_issue`, `quote_number_invalid`, `external_reference_invalid`,
`customer_field_invalid`, `line_description_invalid` (> 300 characters),
`line_sku_invalid`, `line_source_system_invalid`, `line_item_reference_invalid`,
`line_quantity_out_of_range`, `line_unit_amount_out_of_range`,
`line_tax_rate_out_of_range`, `line_arithmetic_mismatch`,
`totals_arithmetic_mismatch`, `totals_out_of_range`, `line_count_out_of_range`,
`idempotency_request_hash_invalid`, `idempotency_resource_unresolved`,
`delivery_without_document`, `delivery_sent_without_sent_at`.

Some cases are not specified by the frozen mapping. In each of these R1.4
chose to raise an exception rather than truncate or invent:

- customer text over V2 limits;
- a committed V1 quote without a document;
- a cancelled quote without `cancelled_at`.

### Legacy artifacts

The database migration cannot read the document root. `npm run
documents:verify` (`…:runtime` in `dist/`) checks every manifest against its
stored bytes. It reports `missing`, `hash_mismatch` or `byte_length_mismatch`
per document (ids only) and exits 2 on any problem. It never writes, moves or
regenerates a file. With `--record-byte-length` it records verified legacy
sizes; that is the only manifest change the trigger allows.

## 6. Database roles and grants

| Principal | Kind | Privileges | Used by |
|---|---|---|---|
| migration principal (e.g. `quote_migrator`) | LOGIN, **owner of the database** | Owns `quote_service` objects and `public.schema_migrations`; creates the trusted `pgcrypto` extension | `db:migrate`, `db:check`, `db:grants`, `documents:verify` via `MIGRATION_DATABASE_URL` |
| `quote_runtime` | NOLOGIN group | Granted by `quote_service.apply_runtime_grants()` (below) | — |
| runtime login (e.g. `quote_app`) | LOGIN, member of `quote_runtime` | Inherited | the server, via `DATABASE_URL` |

Runtime grants:

- `USAGE` on schema `quote_service`.
- `SELECT, INSERT, UPDATE` on `quotes`, `issuance_operations`, `quote_deliveries`.
- `SELECT, INSERT, UPDATE, DELETE` on `quote_lines`, `quote_shipping` (draft
  edits; the guard trigger blocks non-drafts).
- `SELECT, INSERT` on `quote_documents`, `quote_audit_events`,
  `idempotency_bindings`.
- `SELECT` on `schema_migration_checksums` and `public.schema_migrations`.
- `USAGE, SELECT` on `quote_number_seq`.
- **Nothing** on `quote_legacy_v1`.

The runtime owns nothing, so it cannot run `ALTER`, `DROP`, `TRUNCATE`,
`CREATE` (in `quote_service` or, on PostgreSQL ≥ 15, in `public`), reset the
sequence, read legacy evidence or re-grant itself. The integration test
`database-roles` proves each of these.

Provisioning is out of band. The repository holds no credentials. Example SQL
for a DBA, with secrets from the secret store:

```sql
create role quote_runtime nologin;
create role quote_migrator login password :'migrator_secret';
create role quote_app login password :'app_secret' in role quote_runtime;
create database pesaschile_quote_service owner quote_migrator;
-- then, as quote_migrator: npm run db:migrate:runtime -- up
-- if quote_runtime was created after migrating: npm run db:grants:runtime
```

PostgreSQL ≥ 15 is assumed: `public` has no `CREATE` for `PUBLIC`. The local
compose file uses 16.

## 7. Recovery model

Production is **forward-only after a verified backup**:

```
backup (database + document root) → verify restore → db:migrate (migration role)
→ db:check (READY) → documents:verify → start service
```

If anything fails, **restore the backup**, fix the cause (for example the data
behind a migration exception) and migrate forward again. `000007` is
irreversible (`down = false`), and `down` is never a production recovery
mechanism. The other `down` functions exist only for local tests. The
production backup/restore rehearsal belongs to R1.7.

## 8. V1 runtime retirement (owner decision, R1.4)

The V1 API, repositories and workers cannot run on the V2 schema, and a
compatibility persistence layer is excluded. With explicit owner approval,
R1.4 therefore removed:

- the `/v1/*` routes and presenters;
- the V1 application services;
- the Postgres repositories;
- the V1 email worker, expiry job and orphan cleanup;
- HMAC document references;
- the V1 issuance adapter;
- the related tests.

`/v1/*` now returns 404. The formal `410 api_version_retired` remains with
the R1.6/R1.7 cutover.

Kept for reuse: the domain arithmetic code, the PDF renderer and view model,
the email template and Gmail adapter, and the generic job runner.

The runtime currently serves health only. The readiness gate stays in place
for the R1.5 routes, injected through `BuildApplicationOverrides.businessRoutes`.

## 9. Deferred runtime semantics (R1.5+)

| Item | Owner slice |
|---|---|
| V2 routes, closed schemas, error catalog (principal registry and scope enforcement: done in R1.5A, [principals.md](principals.md)) | R1.5 |
| ~~Acceptance transaction for `POST /v2/quotes`~~ (R1.5A.2, `quote-v2-acceptance.ts`) and ~~drafts / issue-a-draft~~ (R1.5A.3, `quote-v2-drafts.ts`): done | — |
| ~~Issuance operation core: claim / lease / fencing / backoff / deadline sweep, T10 state primitive~~ (R1.5B1, [issuance-operation-core.md](issuance-operation-core.md)): done, not yet composed | — |
| Inline budget, content-addressed artifact write, manifest commit | R1.5B3 |
| Operator retry tooling (A1, T10); cancel-after-failed-issuance (T11) is done (R1.5A.4) | R1.6 |
| Expiry projection and materialization job | R1.5 |
| V2 email delivery worker on `quote_deliveries` (lease, `unknown` outcome) | R1.6 |
| Relocation of legacy artifacts into the content-addressed layout (re-hash, then update the storage key through a migration) | R1.6/R1.7 |
| Retention policy for snapshots, documents and bindings (nothing is deleted until ratified) | U1 |
| Production roles, backup/restore rehearsal, data inventory | R1.7 |
