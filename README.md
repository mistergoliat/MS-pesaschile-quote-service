# MS PesasChile Quote Service

Owner service for PesasChile commercial quotes, being rebuilt on the frozen
**V2 contract** ([`docs/v2/`](docs/v2/README.md)).

| Slice | Status |
|---|---|
| R1.2 V2 contract | frozen (amendments A1–A3 applied in R1.4) |
| R1.3 runtime reliability and health | done: [docs/runtime-lifecycle.md](docs/runtime-lifecycle.md) |
| R1.4 V2 schema and migration foundation | done: [docs/v2-persistence.md](docs/v2-persistence.md) |
| R1.5 V2 API, idempotency, durable issuance | in progress: principal registry (A.1) and transactional acceptance (A.2) done |

**Current runtime:** health endpoints and the readiness-gated business
context. The V1 API (`/v1/*`), its repositories and workers were retired in
R1.4, because their persistence model was replaced by the V2 schema. The V2
API arrives in R1.5. Not production-ready: see the
[bootstrap runbook (draft)](docs/runbooks/production-bootstrap.md).

## Stack

Node.js 20 · TypeScript · Fastify · Zod · PostgreSQL (`pg`, `node-pg-migrate`)
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
| `npm run pdf:preview`, `pdf:benchmark`, `pdf:concurrency-smoke` | PDF renderer previews and checks |
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

Semantics, failure policy and configuration:
[docs/runtime-lifecycle.md](docs/runtime-lifecycle.md). Principals, scopes and
credentials: [docs/principals.md](docs/principals.md); the V1 global
`SERVICE_AUTH_TOKEN` is retired.

## Persistence

V2 schema (`quote_service`), the one-way V1 → V2 data migration, migration
checksums, the migration/runtime role separation and the recovery model:
[docs/v2-persistence.md](docs/v2-persistence.md). Schema head:
`000008_quote_v2_runtime_grants`.

## Document rendering and branding

- **Renderer:** `quote-pdf-v3`, in-process pdfmake, PDF-standard Helvetica,
  repository-owned logo. It never queries the database or re-prices; it
  renders from an issued snapshot. Historical documents are never
  regenerated.
- **Brand:** `pesaschile-brand-v1` under `src/infrastructure/branding`;
  repository-controlled assets, no CDN.
- **Email template:** `quote-email-v2`, table-based HTML with an email view
  model. The V2 template and renderer (Chile-local dates, validity-through
  date, per-charge tax labels, shipping block) are R1.5 work.

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
