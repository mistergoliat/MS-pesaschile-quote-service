# MS PesasChile Quote Service

Owner service for PesasChile commercial quotes, being rebuilt on the frozen
**V2 contract** ([`docs/v2/`](docs/v2/README.md)).

| Slice | Status |
|---|---|
| R1.2 V2 contract | frozen (amendments A1–A3 applied in R1.4) |
| R1.3 runtime reliability and health | done: [docs/runtime-lifecycle.md](docs/runtime-lifecycle.md) |
| R1.4 V2 schema and migration foundation | done: [docs/v2-persistence.md](docs/v2-persistence.md) |
| R1.5 V2 API, idempotency, durable issuance | in progress: principal registry (A.1), transactional acceptance (A.2) and draft workflow (A.3) done |

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
| `npm run documents:verify` / `documents:verify:runtime` | verify stored artifacts against their manifests (`--record-byte-length` for legacy sizes) |
| `npm run smoke:docker` | build the image and smoke the runtime (migrate, check, health, restart, shutdown) |
| `npm run pdf:preview`, `pdf:benchmark`, `pdf:concurrency-smoke` | formal PDF previews (template v4), cost and concurrency checks |
| `npm run pdf:determinism` / `pdf:determinism:runtime` | SHA-256 of the golden formal-PDF fixtures (must equal the pinned values on every OS) |
| `npm run email:preview` | offline email template preview |
| `QUOTE_SMOKE_RECIPIENT=… npm run email:smoke:pdf` | real Gmail smoke (manual, needs Gmail configuration) |

## HTTP surface

| Route | Auth | Meaning |
|---|---|---|
| `GET /health/live` | none | process answers; never probes dependencies |
| `GET /health/ready` | none | `200` only when database, schema head (including integrity), storage, renderer and lifecycle are ok |
| `GET /health/dependencies` | principal with `service:health:dependencies` | sanitized dependency and worker detail (contract `DependencyHealth`) |
| `GET /health` | none | deprecated liveness alias |
| `POST /v2/quotes` | `quotes:create` (+ `quotes:validity:override` for `validityOverride`) | transactional create-and-issue **acceptance**: one quote, number, validity, pending issuance operation, binding and audit in one transaction → `202` `issuing`. Replays return the same quote; a changed body under the same key → `409`. No PDF yet (R1.5B) |
| `POST /v2/quotes/drafts` | `quotes:draft:write` | editable draft, version 1, owner totals; no number, validity, operation or document → `201` |
| `PATCH /v2/quotes/{quoteId}/draft` | `quotes:draft:write` | replaces the present top-level members (`shipping: null` removes), recomputes totals, version + 1, fenced by `expectedVersion` (`409 version_conflict`) → `200` |
| `POST /v2/quotes/{quoteId}/issue` | `quotes:issue` (+ `quotes:validity:override`) | same acceptance as `POST /v2/quotes` applied to the draft at `expectedVersion`: same `quoteId`, number, validity, pending operation → `202` `issuing`. No PDF yet (R1.5B) |

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
- **Brand:** `pesaschile-brand-v1` under `src/infrastructure/branding`;
  repository-controlled assets, no CDN.
- **Email template:** `quote-email-v2`, table-based HTML with the legacy V1
  email view model (V2 email refactor: R1.6).

## Architecture

`src/domain` (V1 domain and exact CLP arithmetic, kept for reuse) ·
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
