# Quote Service V2 — Implementation Roadmap R1.3–R1.7

Status: **PLAN (R1.2)**. Each slice requires explicit authorization before it
starts. None of these slices touches a consumer; consumer integration starts
only after R1.7's gate. The contract in this directory is frozen: a slice that
needs a contract change stops and raises a contract amendment instead.

## R1.3 — Runtime reliability and health (no business-route change)

- `/health/live`, `/health/ready` (database, schema head, storage, renderer,
  lifecycle), `/health/dependencies` (scope-protected, sanitized).
- Process stays up on database outage: bind health routes after static config
  validation, bounded reconnect backoff, business routes `503`.
- Schema-head validation (expected migration head + checksum) at boot and in
  readiness; server never runs DDL.
- Separate migration and runtime database roles/config.
- Supervisor policy: capped restarts with alert; documented that restart is
  not recovery.
- Backup/restore runbook for database and document root.
- Exit criteria: failure-injection tests (DB refused, timeout, bad
  credentials, recovery without restart, stale schema, read-only/full disk,
  renderer failure) green.

## R1.4 — V2 domain core and schema

- Forward migration `000006` (V2 tables: quotes, lines, shipping, validity,
  documents/manifests, issuance operations, bindings, deliveries, audit;
  principal columns; bigint numbering) — no V1 route removal yet.
- Domain: states and transitions (state machine T1–T9), customer kinds and
  RUT check digit, item/line/shipping snapshots, normative arithmetic,
  `expectedTotals`, validity policy engine (IANA tz, pinned tzdb version),
  override rules, numbering format.
- Exit criteria: unit tests for arithmetic boundaries (half-up ties, included
  / excluded / exempt, overflow), validity E1–E7 + transitions of two years +
  `TZ` independence, transition guards; migration tests from empty and from a
  V1 snapshot in a disposable database.

## R1.5 — V2 API, idempotency and durable issuance

- Fastify `/v2` routes exactly per `openapi.yaml`; closed request schemas;
  error catalog; evaluation order.
- Principal registry (hashed tokens, scopes, visibility rule).
- Bindings (principal scope, fingerprint, lookup, replay-current-state,
  conflict) and audit `idempotency.*`.
- Issuance operation: acceptance transaction, inline budget, worker with
  lease/fencing/backoff/deadline sweep, content-addressed artifact write,
  manifest commit, `201/200/202` semantics.
- Renderer/template v4: Chile-local dates, validity-through date,
  per-charge tax labels, shipping block, no global VAT claim unless true,
  deterministic PDF metadata.
- Expiry projection on reads + idempotent expiry materialization job.
- Document endpoint with hash verification.
- Exit criteria: OpenAPI conformance tests (every example validates, every
  response validates), concurrency tests (same key ×N, cross-principal),
  crash-window tests (kill before/after acceptance commit, during render,
  after file write, after manifest commit, zombie holder), deadline sweep
  test, no-email-on-issue assertion.

## R1.6 — Delivery, observability, integrity and V1 retirement tooling

- Email delivery V2 behind the generic mail port; provider disabled by
  configuration; ambiguous outcome → `unknown`; fake sender in tests only.
- Structured domain events and log redaction; metrics for worker queues.
- Artifact integrity check job; operator repair procedure (hash-reproducing
  re-render only).
- V1 → V2 data migration tooling per [mapping](QUOTE_V2_V1_MIGRATION.md) with
  exception report; restore rehearsal in an isolated environment.
- `/v1/*` → `410 api_version_retired`.
- Exit criteria: migration rehearsal report, redaction tests, delivery state
  tests, integrity job tests.

## R1.7 — Production provisioning and cutover

- Consumer and data inventory (database, backups, document root, deployed
  callers, credentials) — read-only first.
- Provision PostgreSQL, roles, network restriction, secret store entries,
  persistent document volume and backups; verify restore.
- Run the migration with the migration role; verify schema head.
- Deploy V2 with email provider disabled; read-only production smoke
  (`/health/*`, authenticated list/read returning no PII).
- Seven consecutive days of stable operation (no unplanned restart, no stuck
  issuing operation, dependency recovery demonstrated).
- Separately approved synthetic create-and-issue canary (synthetic guest
  customer, no email, documented retention/cleanup).
- Exit: owner readiness gate passed; only then may a consumer integration
  phase be authorized.
