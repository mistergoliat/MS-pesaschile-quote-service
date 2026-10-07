# MS PesasChile Quote Service

Owner service for PesasChile commercial quotes, being rebuilt on the frozen
**V2 contract** ([`docs/v2/`](docs/v2/README.md)).

| Slice | Status |
|---|---|
| R1.2 V2 contract | frozen (amendments A1–A3 applied in R1.4) |
| R1.3 runtime reliability and health | done: [docs/runtime-lifecycle.md](docs/runtime-lifecycle.md) |
| R1.4 V2 schema and migration foundation | done: [docs/v2-persistence.md](docs/v2-persistence.md) |
| R1.5 V2 API, idempotency, durable issuance | in progress: A.1–A.4 done; B1 operation core, B2 formal document, B3 publication + fenced commit + inline issuance done ([docs/issuance-execution.md](docs/issuance-execution.md)); B4 document endpoint, integrity verifier and process-kill crash matrix done ([docs/document-access.md](docs/document-access.md), [docs/issuance-crash-matrix.md](docs/issuance-crash-matrix.md)) |
| R1.6 operation and delivery | closed: A delivery request, B delivery execution ([docs/email-delivery-execution.md](docs/email-delivery-execution.md)), C operator controls ([docs/operator-controls.md](docs/operator-controls.md)), D operational hardening ([docs/operational-hardening.md](docs/operational-hardening.md), runbook [docs/runbooks/degraded-operation.md](docs/runbooks/degraded-operation.md)). R1.7 production readiness is next |

**Current runtime:** health endpoints and the readiness-gated business
context. The V1 API (`/v1/*`), its repositories and workers were retired in
R1.4, because their persistence model was replaced by the V2 schema. The V2
API arrives in R1.5. Not production-ready: see the
[bootstrap runbook (draft)](docs/runbooks/production-bootstrap.md).

## Stack

Node.js 24 (pinned: `.nvmrc`, `engines`, `node:24.14.0` image; the formal PDF
renderer refuses any other Node major or zlib build) · TypeScript · Fastify · Zod · PostgreSQL (`pg`, `node-pg-migrate`)
· `pdfmake` (native PDF renderer, no browser) · Vitest · ESLint.

## Local setup

```bash
npm ci
cp .env.example .env
npm run db:compose:up            # disposable PostgreSQL 16
npm run db:migrate -- up         # explicit DDL; the server never migrates
npm run db:check                 # exit 0 only at the expected head with verified checksums
npm run dev
curl -i localhost:3000/health/ready
```

## Commands

| Command | Purpose |
|---|---|
| `npm run verify` | lint, typecheck, full test suite (Docker PostgreSQL), build |
| `npm run test:unit` | unit tests only (no database) |
| `npm run db:migrate -- up` / `db:migrate:runtime` | apply migrations (uses `MIGRATION_DATABASE_URL`, else `DATABASE_URL`) |
| `npm run db:check` / `db:check:runtime` | connectivity, schema head and migration integrity, as readiness sees them |
| `npm run db:manifest` | regenerate the migration manifest after adding a migration |
| `npm run db:grants` / `db:grants:runtime` | re-apply the `quote_runtime` grants |
| `npm run principals:token` | new caller token plus the SHA-256 for the principal registry |
| `npm run documents:verify` / `documents:verify:runtime` | integrity check, detection only: every committed manifest against its bytes (OK / MISSING / HASH_MISMATCH / LENGTH_MISMATCH / READ_FAILED / KEY_INVALID / OVERSIZED; exit 2 on any problem; `--record-byte-length` for legacy sizes) |
| `npm run issuance:failed` / `issuance:failed:runtime` | operator: read-only list of quotes whose current issuance operation is `failed` ([operator-controls.md](docs/operator-controls.md)) |
| `npm run issuance:retry` / `issuance:retry:runtime` | operator: T10 retry of a failed issuance (`--operator`, `--reason`; dry run unless `--yes`) |
| `npm run documents:repair` / `documents:repair:runtime` | operator: restore a missing V2 PDF only if the re-render reproduces the recorded `pdfSha256` (dry run unless `--yes`) |
| `npm run smoke:docker` | build the image and smoke the runtime (migrate, check, health, restart, shutdown) |
| `npm run rehearsal:migration` | synthetic V1 → V2 migration rehearsal on disposable local databases; writes [docs/R1.6D_SYNTHETIC_MIGRATION_REHEARSAL.md](docs/R1.6D_SYNTHETIC_MIGRATION_REHEARSAL.md) |
| `npm run pdf:preview`, `pdf:benchmark`, `pdf:concurrency-smoke` | formal PDF previews (template v4), cost and concurrency checks |
| `npm run pdf:determinism` / `pdf:determinism:runtime` | SHA-256 of the golden formal-PDF fixtures (must equal the pinned values on every OS) |
| `npm run email:preview` | offline preview of the V2 email envelope (`.preview/`; sends nothing) |

## HTTP surface

| Route | Auth | Meaning |
|---|---|---|
| `GET /health/live` | none | process answers; never probes dependencies |
| `GET /health/ready` | none | `200` only when database, schema head (including integrity), storage, renderer and lifecycle are ok |
| `GET /health/dependencies` | principal with `service:health:dependencies` | sanitized dependency and worker detail (contract `DependencyHealth`) |
| `GET /health` | none | deprecated liveness alias |
| `POST /v2/quotes` | `quotes:create` (+ `quotes:validity:override` for `validityOverride`) | transactional create-and-issue **acceptance**: one quote, number, validity, pending issuance operation, binding and audit in one transaction → `201` `issued` when the formal PDF commits within `QUOTE_ISSUANCE_SYNC_BUDGET_MS`, else `202` `issuing` (the worker continues). Replays return the same quote in its current state; a changed body under the same key → `409` |
| `POST /v2/quotes/drafts` | `quotes:draft:write` | editable draft, version 1, owner totals; no number, validity, operation or document → `201` |
| `PATCH /v2/quotes/{quoteId}/draft` | `quotes:draft:write` | replaces the present top-level members (`shipping: null` removes), recomputes totals, version + 1, fenced by `expectedVersion` (`409 version_conflict`) → `200` |
| `POST /v2/quotes/{quoteId}/issue` | `quotes:issue` (+ `quotes:validity:override`) | same acceptance as `POST /v2/quotes` applied to the draft at `expectedVersion`: same `quoteId`, number, validity → `200` `issued` within the sync budget, else `202` `issuing` |
| `POST /v2/quotes/{quoteId}/deliveries/email` | `quotes:delivery:email` (+ visibility) | the **only** email trigger. Queues one durable `pending` delivery of an effectively `issued` quote (recipient snapshot, pinned PDF hash, audit, binding) → `202`; never sends synchronously. The delivery worker sends it when `QUOTE_EMAIL_PROVIDER=gmail`; with the default `disabled` it answers `503 dependency_unavailable` (`email_provider`). See [docs/email-delivery-request.md](docs/email-delivery-request.md) and [docs/email-delivery-execution.md](docs/email-delivery-execution.md) |
| `GET /v2/quotes/{quoteId}/deliveries/{deliveryId}` | `quotes:read` (+ visibility) | contract `Delivery` (masked recipient only) → `200` |

Semantics, failure policy and configuration:
[docs/runtime-lifecycle.md](docs/runtime-lifecycle.md). Principals, scopes and
credentials: [docs/principals.md](docs/principals.md); the V1 global
`SERVICE_AUTH_TOKEN` is retired.

## Persistence

V2 schema (`quote_service`), the one-way V1 → V2 data migration, migration
checksums, the migration/runtime role separation and the recovery model:
[docs/v2-persistence.md](docs/v2-persistence.md). Schema head:
`000009_quote_snapshot_child_insert_guard`.

## Document rendering and branding

- **Formal PDF (R1.5B2):** frozen issued snapshot → `IssuedQuoteDocumentModelV2`
  → pdfmake, template `quote-pdf-template-v4`, issuer profile
  `pesaschile-cl-v1`, embedded DejaVu Sans 2.37, code-owned renderer version.
  Pure, deterministic, no arithmetic, no lookups, no printable HTML, no
  personal signature: [docs/formal-document-v2.md](docs/formal-document-v2.md).
- **Brand assets:** `asset://pesaschile-brand-v1/*` under
  `src/infrastructure/branding`; repository-controlled files, no CDN.
- **Email envelope:** `quote-email-envelope-v3`: a communication wrapper
  around the attached formal PDF, with no commercial content (provisional copy,
  owner approval at R1.7): [docs/email-delivery-execution.md](docs/email-delivery-execution.md).

## Architecture

`src/application` (health monitor, document view models) ·
`src/infrastructure` (config, persistence, documents, branding, email
adapter, runtime) · `src/http` (health routes, readiness gate, errors).

## Testing

- **Unit tests:** pure logic, including the monitor, schema head, manifest
  integrity, the renderer probe and environment parsing.
- **Integration tests:** real PostgreSQL through Docker Compose:
  - runtime reliability (outage, recovery, shutdown, a real `server.ts` process);
  - the V2 migration matrix: fresh database, representative V1 snapshot,
    determinism, exceptions, constraints, integrity tamper, legacy artifacts;
  - database role separation.
