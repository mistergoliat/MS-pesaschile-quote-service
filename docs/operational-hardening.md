# R1.6D — Operational Hardening

Status: **CLOSED** on `quote-r1.6d-operational-hardening` (base `245320f`).
R1.6 milestone state: R1.6A CLOSED · R1.6B CLOSED · R1.6C CLOSED ·
R1.6D CLOSED · **R1.6 CLOSED** · R1.7 NEXT.

R1.6D adds no commercial feature. It makes the finished service
operationally truthful: each route and job waits only for the dependencies
it actually uses; expired quotes are eventually materialized; stored
documents are checked periodically; worker backlog metrics come from the
database; `/v1/*` is formally retired; logs are proven free of secrets and
PII; and the V1 → V2 migration is rehearsed on synthetic data.

No Quote, issuance or delivery semantics changed. No frozen contract
document changed (validator 475/475). No migration was added (head
`000009_quote_snapshot_child_insert_guard`).

Authority: frozen `docs/v2` + amendments A1–A6 > pre-flight audit
(`R1.6_PRE_FLIGHT_OPERATION_DELIVERY_AUDIT.md` §21–§25, §29, §31) > this slice.

## 1. Capability model

`DependencyMonitor` (`src/application/health/dependency-monitor.ts`) keeps
its cached probe records and adds an internal capability gate:
`gate(capability): BusinessGateRejection | null` and `canRun(capability)`.
`businessGate()` remains as an alias of `gate("ISSUANCE")`. Capabilities are
never exposed by the API.

Every capability requires `PERSISTENCE` (not shutting down, database `up`,
schema `READY`). The checks run in a fixed order: lifecycle → database →
schema → artifact storage → renderer.

| Capability | Requires | Used by |
|---|---|---|
| `PERSISTENCE` | lifecycle + database + schema | reads, list, operation, audit, idempotency lookup, delivery read, drafts, cancel, expiry job, delivery `unknown` sweep |
| `DEADLINE_SWEEP` | = `PERSISTENCE` | issuance deadline sweep (and the issuance metrics it measures) |
| `DOCUMENT_READ` | `PERSISTENCE` + artifact storage | `GET …/document`, integrity job |
| `ISSUANCE` | `PERSISTENCE` + artifact storage + renderer | `POST /v2/quotes`, `POST …/issue`, issuance worker (and the inline attempt, via `isReady()`, which is the same set) |
| `DELIVERY_REQUEST` | = `PERSISTENCE` | `POST …/deliveries/email` |
| `DELIVERY_SEND` | `DOCUMENT_READ` | email send runner |

The email provider is never part of a gate.

- **Configured or not** is decided by composition (no sender means no send
  runner) and by the delivery request itself. That check (`503
  email_provider`) runs after the binding lookup, so a bound key still
  replays when the provider is later disabled (A6). Putting it in the gate
  would break that order.
- **Provider health** is the send runner's own outcome classification
  (R1.6B). A Gmail failure changes `emailProvider` in health. It never stops
  the runner from trying again, and never affects requests, reads,
  documents or readiness.

### 1.1 Route declaration

Each business route declares `config.capability` next to `config.requiredScope`.
`enforceRouteCapabilities` (`src/http/readiness-gate.ts`) does two things:

- it rejects a route without a capability at registration, so startup fails;
- it gates every request in `onRequest`, before body parsing, authentication
  or any repository call (the same position as the old global gate).

| Route | Capability |
|---|---|
| `POST /v2/quotes` | `ISSUANCE` |
| `POST /v2/quotes/drafts` | `PERSISTENCE` |
| `PATCH /v2/quotes/{id}/draft` | `PERSISTENCE` |
| `POST /v2/quotes/{id}/issue` | `ISSUANCE` |
| `POST /v2/quotes/{id}/cancel` | `PERSISTENCE` |
| `GET /v2/quotes/{id}` | `PERSISTENCE` |
| `GET /v2/quotes` | `PERSISTENCE` |
| `GET /v2/quotes/{id}/document` | `DOCUMENT_READ` |
| `GET /v2/operations/{id}` | `PERSISTENCE` |
| `GET /v2/quotes/{id}/audit` | `PERSISTENCE` |
| `GET /v2/idempotency/current` | `PERSISTENCE` |
| `POST /v2/quotes/{id}/deliveries/email` | `DELIVERY_REQUEST` |
| `GET /v2/quotes/{id}/deliveries/{deliveryId}` | `PERSISTENCE` |

`test/integration/capability-gating.integration.test.ts` pins this exact
matrix. A new route without a capability fails startup. A new classified
route fails the test until the matrix is updated.

Issuance acceptance stays fully gated, including idempotent replays of
`POST /v2/quotes` and `POST …/issue`. That keeps the pre-R1.6D behavior of
those routes: issuance correctness was not weakened.

### 1.2 `/health/ready` is unchanged

`readiness()` and the route are untouched. The body is the frozen
`Readiness` (five checks, `ok`/`fail`). It still means "this instance can
perform the full issuance write path". The renderer and storage still make
it `503`. Email never does, and no capability field was added. The
regression test validates it against the OpenAPI schema and checks the
exact key sets.

### 1.3 Degradation matrix (tested)

| Outage | Readiness | Still available | Refused (`503 dependency_unavailable`) |
|---|---|---|---|
| renderer | `503` (renderer `fail`) | every read, list, operation, audit, idempotency lookup, `GET …/document`, drafts, cancel, delivery request and read; expiry, sweeps, email send, integrity job | create-and-issue, issue (`dependency: renderer`); issuance worker paused |
| artifact storage | `503` (artifactStorage `fail`) | every read except the document, drafts, cancel, delivery request and read; expiry and both sweeps | `GET …/document`, create-and-issue, issue (`dependency: artifactStorage`); issuance worker, email send and integrity job paused |
| database | `503` | liveness `200` | every business route (`dependency: database`); every job paused, nothing mutated |
| email provider failing | `200` | everything; delivery requests still `202` | nothing (the send runner classifies each outcome) |
| email provider disabled | `200` | everything except new delivery requests | new delivery key → `503 email_provider` (`retryable: false`); a bound key still replays `202` |

Intended behavior change: before R1.6D, a renderer outage also returned
`503` for reads and for `GET …/document`. The R1.3/R1.5 reliability probe
routes are now declared `ISSUANCE`, so their full-gate assertions still mean
the same thing.

## 2. Expiry materialization (T9)

`src/infrastructure/persistence/postgres/quote-v2-expiry.ts`
(`materializeExpiredQuotes`) and the `expiry` runner
(`src/infrastructure/runtime/maintenance-jobs.ts`).

- Selection: stored `issued` and `valid_until_exclusive <= now` (database
  clock, read once and bound, so the planner can use the
  `quotes_issued_validity_idx` partial index). Ordered by boundary, then id.
  Bounded batches (100 per transaction, at most 10 per tick).
  `FOR UPDATE SKIP LOCKED`.
- Transition: `status = 'expired'`, `expired_at = valid_until_exclusive`
  (the contractual boundary, never the run time), `version + 1`,
  `updated_at` = database time. Audit `quote.expired`: principal `system`,
  `issued → expired`, the quote's current operation id, data
  `{quoteNumber, previousVersion, version}`. No other side effect: the
  document is untouched, and pending deliveries are still failed by the
  delivery claim (A6.1/W2).
- Concurrency: a quote held by a cancel, another expiry worker or any
  quote-locking transaction is skipped, never waited on. A row committed by
  someone else after the statement's snapshot is re-checked against
  `status = 'issued'` once locked. Each quote therefore transitions and is
  audited exactly once, across any number of instances. No lock cycles are
  possible (no waits on quote rows).
- Idempotent: a materialized quote is never selected again, so there is no
  version, timestamp or audit churn.
- Races (state machine §3): if expiry commits first, a cancel waiting on the
  row sees `expired` and answers `409 invalid_state_transition`
  (`details.status = "expired"`). If the cancel commits first (before the
  boundary), the expiry job never touches the cancelled quote.
- Reads are unchanged. The projection already answers `expired` with
  `expiredAt = validUntilExclusive`. After materialization the
  representation is identical except `version` and `updatedAt`.
- The time source is always the database clock. Injected test clocks only
  steer the read projection.
- Cadence: `QUOTE_EXPIRY_INTERVAL_MS` (default **60 000 ms**, range
  1 000–3 600 000). Reads are already correct, so the cadence only bounds
  how long stored state and audit lag the boundary. Implementation
  configuration, not an API invariant.
- Gate: `PERSISTENCE`. Renderer, storage and email outages never stop it.
  It stops between batches on shutdown. A transaction is all or nothing, so
  the job resumes idempotently on the next tick or instance.
- Log: one `expiry.materialized` line per tick with `count`, never per
  quote. The durable record is the audit event.

## 3. Periodic document integrity (W7)

`createDocumentIntegrityJob` in `maintenance-jobs.ts`.

- It is a scheduler around the **same** `verifyDocumentArtifacts` that
  `documents:verify` runs, with `recordLegacyByteLength: false`. The
  categories are the established ones (`MISSING`, `HASH_MISMATCH`,
  `LENGTH_MISMATCH`, `READ_FAILED`, `KEY_INVALID`, `OVERSIZED`).
- Detection only. It never calls repair, never renders, writes, moves or
  deletes bytes, and never changes a manifest, quote or operation. A static
  test checks the module, and an integration test checks storage and every
  table before and after.
- Opt-in: `QUOTE_INTEGRITY_CHECK_INTERVAL_MS`, default **0 = disabled**,
  otherwise 1 000–604 800 000 ms. R1.7 decides the production cadence and
  alert routing. Nothing is enabled just because the code exists.
- Gate: `DOCUMENT_READ`. A renderer outage does not matter. A storage or
  database outage pauses it. The verifier checks the gate before every batch
  (`shouldContinue`). A scan that loses its dependencies part-way logs no
  per-artifact problems, because an unmounted volume would otherwise read as
  `MISSING`. It logs only an interrupted summary.
- Never affects `/health/ready`. A corrupt document is an operational
  signal, not a readiness failure.
- Logs:
  - one `document.integrity_failed` (error level) per problem, with
    `source: "integrity_scan"`, `quoteId`, `documentId`, `origin`,
    `category` and `pdfSha256`; never a path, storage key, customer data or
    bytes;
  - one `document.integrity_scan_completed` per scan, with `completed`,
    `checked`, `ok`, `problems`, `byStatus` and `durationMs`. It logs at info
    level when the scan is clean, and at warn level otherwise;
  - no line at all for healthy artifacts.
- Concurrency: `PeriodicJobRunner` is single-flight, so a tick never
  overlaps a running scan in one process. Several instances may scan
  independently. That is acceptable: the scan is read-only and bounded
  (keyset batches of 200). No distributed lock was added.
- `documents:verify` output gained `complete` and per-problem `pdfSha256`
  (both additive).

## 4. Queue metrics (`/health/dependencies` `workers.*`)

"Queue" means work that is due now for that worker. This is the R1.6B
`emailDelivery` definition, applied to every worker. All values come from
the database clock and are read only. They are measured by persistence-gated
ticks and served from cache, never queried per health request.

| Worker | `queueDepth` | `oldestPendingAgeSeconds` | Measured by | Indexes |
|---|---|---|---|---|
| `issuance` | operations that are the current operation of an `issuing` quote, before `deadline_at`, and either `pending` with `next_attempt_at <= now` or `running` with an expired lease (reclaimable). This is exactly the claim's eligibility | seconds since the oldest one became due (`next_attempt_at` or `lease_expires_at`) | each `issuanceDeadlineSweep` tick (`DEADLINE_SWEEP`), so the backlog stays visible while the worker is paused by a renderer or storage outage | `issuance_operations_pending_due_idx`, `…_running_lease_idx` |
| `expiry` | stored `issued` quotes with `valid_until_exclusive <= now` (still to be materialized) | seconds since the oldest unmaterialized boundary | each `expiry` tick, after materializing | `quotes_issued_validity_idx` |
| `emailDelivery` | unchanged from R1.6B: due `pending` deliveries | since the oldest became due | each `deliveryOutcomeSweep` tick | `quote_deliveries_pending_due_idx` |

Excluded everywhere: terminal rows, future backoff or retries, live leases.
For issuance, operations past their deadline are also excluded: they belong
to the deadline sweep, not the worker.

Limitation, documented rather than worked around: the frozen `WorkerStatus`
has no "unknown" value (`queueDepth` is a required integer). Before a
worker's first measurement (`lastPollAt: null`), or when a worker is not
composed (`enabled: false`), it reports `0` / `null`. A failed measurement
keeps the last successful one. `lastPollAt` (and the `job.failed` log) shows
staleness. No fake zero is written after a failed query.

## 5. V1 HTTP retirement

`/v1` and `/v1/*`, every method (`app.all`), answer `410` with the frozen
envelope:

```json
{"error":{"code":"api_version_retired","message":"API version 1 is retired; use /v2.","requestId":"…"}}
```

The answer is produced in `onRequest`, before body parsing, authentication
and any dependency gate. The contract requires no credential to learn that
a version is retired, and the answer does not depend on the body (malformed,
oversized, unsupported media type) or on outages. `/v10`, `/v11`, `/v1x` and
`/v2` are not matched. There is no legacy fallback. The code ships now.
Going live is the R1.7 cutover; nothing was deployed.

## 6. Redaction hardening

Prevention first: credentials, raw idempotency keys, recipients, provider
text, PDF bytes and snapshots are never passed to a logger (R1.5/R1.6B
design, re-audited for every new log line).

Changes in R1.6D:

- The HTTP error handler's unexpected-`500` line no longer serializes the
  error object. It logs `errorName` and `errorCode` only (the convention
  `job.failed` already used). A driver error's `message`, `stack` and
  `detail` (for example "Failing row contains (…)") can echo row values,
  customer data or connection details.
- Defense in depth: the Fastify logger redacts `req.headers.authorization`,
  `req.headers.cookie` and `req.headers["idempotency-key"]`. The default
  serializers do not log headers anyway.

Hostile test (`test/integration/log-redaction.integration.test.ts`): unique
sentinels for the bearer token, the Gmail access token, refresh token and
client secret, the raw `Idempotency-Key`, recipient email and name, the
provider body, customer name, email and phone, the commercial line text, a
driver `detail` and a DSN password. They go through:

- 401, create, replay, conflict and 422;
- the idempotency lookup, reads, audit and the document;
- three deliveries through the real Gmail adapter against a loopback fake
  (permanent, ambiguous, sent);
- the expiry job and the integrity scan;
- an unexpected 500;
- a database outage;
- an operator CLI failure.

No sentinel appears in any log line. Client surfaces (HTTP bodies, CLI
output) carry no stack frame, absolute path, DSN, provider text or secret.

## 7. Synthetic migration rehearsal

`npm run rehearsal:migration` runs
`test/integration/migration-rehearsal.integration.test.ts` and writes
[R1.6D_SYNTHETIC_MIGRATION_REHEARSAL.md](R1.6D_SYNTHETIC_MIGRATION_REHEARSAL.md).
Plain `npm test` runs the same checks without writing.

- It reuses the established fixture (`test/helpers/v1-fixture.ts`) and the
  real migrator. Nothing is reimplemented.
- It runs on disposable databases on the local test PostgreSQL, created and
  dropped by the run. It never touches production or shared databases.
- Supported fixture: counts reconcile; state, `opportunityId` →
  `externalCorrelation` and delivery mappings hold; manifest hashes match;
  relocated artifacts verify with `documents:verify` semantics; no raw V1
  key survives; schema is `READY` at `000009`; checksums match the packaged
  manifest.
- Exception fixture: the migration is refused inside its transaction. The
  exception report is PII-free and deterministic. V1 data is untouched and
  no V2-only table exists.
- Reproducibility: two independent runs produce an identical canonical V2
  content digest and identical exception report.

## 8. Background jobs after R1.6D

| Job (internal name) | Public `workers` key | Gate | Composed |
|---|---|---|---|
| `issuance` | `issuance` | `ISSUANCE` | always (tests may disable) |
| `issuanceDeadlineSweep` | — | `DEADLINE_SWEEP` | always |
| `expiry` | `expiry` | `PERSISTENCE` | always |
| `emailDelivery` | `emailDelivery` | `DELIVERY_SEND` | when a sender is configured |
| `deliveryOutcomeSweep` | — | `PERSISTENCE` | always |
| `documentIntegrity` | — | `DOCUMENT_READ` | when `QUOTE_INTEGRITY_CHECK_INTERVAL_MS > 0` |

The frozen public worker keys are unchanged. Shutdown order is unchanged:

1. lifecycle → shutting down, so every gate closes and no new work starts;
2. the workers stop claiming;
3. `BackgroundJobManager.stop()` awaits in-flight ticks (expiry stops between
   batches, the integrity scan between verifier batches);
4. HTTP drains;
5. the database pool closes.

In-memory runner state is observability only.

## 9. Cleanup

The pre-flight audit §29 asked for these to be checked in R1.6D. Removed:

- `application/ports/clock-port.ts` and `infrastructure/time/system-clock.ts`,
  which had no importers;
- `infrastructure/documents/filesystem-document-artifact-storage.ts` and its
  two self-tests. It was the V1 storage adapter. Only its own tests used it,
  and the V2 legacy-manifest read path does not depend on its key rules.
  The closure guards that keep it out of the runtime remain.

## 10. Evidence

| Suite | Covers |
|---|---|
| `test/unit/dependency-monitor.test.ts` | capability gate matrix (healthy, renderer, storage, both, database, schema, shutdown); `businessGate` = `gate("ISSUANCE")`; readiness unchanged |
| `test/integration/capability-gating.integration.test.ts` | exact route → capability matrix; unclassified route fails startup; A–F degradation matrix on real outages; `/health/ready` regression |
| `test/integration/expiry-materialization.integration.test.ts` | G–R and AJ–AL: transition, exact boundary, version and audit once, idempotency, projection vs materialization, 8 concurrent workers ×3, both cancel/expiry orders, skip-locked, DB outage, other outages, restart, metrics |
| `test/integration/document-integrity-job.integration.test.ts` | S–AE: disabled by default, enabled scan, healthy silence, missing/hash/length detection, no repair/render/write, readiness unaffected, renderer outage irrelevant, storage/DB pause, mid-scan loss, single flight |
| `test/integration/queue-metrics.integration.test.ts` | AF–AI, AM–AO: due-only issuance metrics, backoff, live/expired leases, terminal and past-deadline exclusion, DB-clock age, read only, backlog visible during a renderer outage, R1.6B email metrics unchanged |
| `test/integration/v1-retirement.integration.test.ts` | AP–AW: every method and path shape, credentials, bodies, outages, `/v10`/`/v1x` not caught, `/v2` intact, envelope validated against `ErrorResponse` |
| `test/integration/log-redaction.integration.test.ts` | AX–BH (§6) |
| `test/integration/migration-rehearsal.integration.test.ts` | BI–BP (§7) |
| `scripts/docker-smoke.mjs` phases 15 and 22 | production image: `/v1/*` 410 for every method, `/v10` 404; a renderer-down container (fonts hidden) serving reads and verified documents and refusing issuance; a seeded issuance backlog reported while the worker is paused; a held expired quote reported by `workers.expiry`, then materialized at the boundary with one audit event; the opt-in integrity job reporting a deleted and a tampered artifact without changing anything |

## 11. Remaining for R1.7 (not R1.6)

R1.7B-S1 adds shared bounded error summaries and authenticated PostgreSQL transport
for runtime and maintenance. See [database-transport.md](database-transport.md).
It does not close the production readiness gate or authorize any items below.

The following stay out of R1.6:

- production integrity-job cadence and alert routing;
- going live with the V1 `410` (cutover);
- the real-data migration rehearsal and legacy artifact relocation;
- U2 tax wording and U3 issuer identity;
- email copy approval (W8);
- production Gmail credentials and W10;
- principal registry secrets;
- production DB roles;
- deployment, backup/restore rehearsal, canary, 7-day stability window and
  rollback drill;
- R4 J3 integration.
