# Quote Service — Runtime Lifecycle, Health and Failure Policy (R1.3)

Status: implemented in R1.3. Applies to the current V1 runtime. Health
endpoint shapes follow the frozen V2 contract (`docs/v2/openapi.yaml`,
`Liveness`, `Readiness`, `DependencyHealth`).

## 1. Invariant

A dependency outage (PostgreSQL, document storage, PDF renderer) never stops
the process. The service stays **live** and becomes **not ready**; business
routes fail closed with `503`; when the dependency comes back, readiness
returns on its own. No process restart is needed. A supervisor (PM2, Docker)
is not a recovery mechanism for dependencies.

## 2. Process lifecycle

```
load + validate static config ── invalid ──────────────▶ exit 1 (runtime.config_invalid)
        │
build application (no I/O against external dependencies)
  └ verify packaged migration set ── inconsistent ─────▶ exit 1 (runtime.init_failed)
        │
onReady: one dependency probe cycle (bounded by HEALTH_PROBE_TIMEOUT_MS, never throws)
        │
bind HTTP ── port unavailable ──────────────────────────▶ exit 1 (runtime.bind_failed)
        │
runtime.started  (live; ready only if every dependency passed)
        │
dependency monitor loop + background jobs start
        │
  ┌─────┴───────────────── steady state ──────────────────┐
  │ healthy: probe every HEALTH_PROBE_INTERVAL_MS          │
  │ unready: retry with backoff HEALTH_PROBE_RETRY_MIN_MS  │
  │          doubling up to HEALTH_PROBE_RETRY_MAX_MS      │
  └────────────────────────────────────────────────────────┘
        │
SIGTERM / SIGINT ─▶ shutdown (section 7) ─▶ exit 0 (exit 1 if the deadline passed)
```

The first probe runs before the socket binds so the first request already
sees real readiness. It delays bind by at most `HEALTH_PROBE_TIMEOUT_MS`
(the three probes run in parallel) and cannot fail startup.

The server never runs migrations or any DDL.

## 3. Failure policy

| Class | Condition | Behavior |
|---|---|---|
| **A. Terminate** (exit 1) | Invalid static configuration | `runtime.config_invalid` on stderr: variable names and rule messages only, never values |
| | Packaged migration set missing, empty, non-canonical or not ending at `EXPECTED_SCHEMA_HEAD` | `runtime.init_failed` |
| | Cannot bind host/port | `runtime.bind_failed`, then bounded shutdown |
| | Programmer error: uncaught exception or unhandled rejection | `runtime.fatal`, then bounded shutdown. These are never swallowed |
| **B. Live, not ready** | PostgreSQL unreachable, auth failure, timeout | `database: fail`; business `503 dependency_unavailable` |
| | Schema missing / behind / ahead or unknown | `schema: fail`; business `503 schema_not_ready` |
| | Document storage cannot create, read back or delete a probe file | `artifactStorage: fail`; business `503 dependency_unavailable` |
| | PDF renderer cannot render an in-memory probe document | `renderer: fail`; business `503 dependency_unavailable` |
| | Shutdown in progress | `lifecycle: fail`; business `503 dependency_unavailable` |
| **C. Optional subsystem degraded** | Email provider failing (Gmail) | Email delivery iterations fail and are retried per the delivery policy. `emailProvider` reports `degraded` in `/health/dependencies`. **Readiness is not affected** |
| | Email provider disabled | Irrelevant: `emailProvider: disabled` |

Supervisor policy: class A exits are deterministic (bad config, bad package,
port taken). Restarting will not fix them. Configure capped restarts with
backoff and alert on them (PM2 `max_restarts` + `exp_backoff_restart_delay`,
or Docker `restart: on-failure:5`). Class B never exits, so it never restarts.

## 4. Health endpoints

None of these handlers probes anything. They read the dependency monitor's
cached state, so they are fast and cannot multiply load on a struggling
database. All responses carry `Cache-Control: no-store`.

### `GET /health/live`: no auth

`200 {"status":"live"}` whenever the process answers HTTP, including during
dependency outages and shutdown. Use it for **restart decisions** (Docker
`HEALTHCHECK`, PM2/Kubernetes liveness).

### `GET /health/ready`: no auth

`200` only when database, schema head, artifact storage, renderer and
lifecycle are all `ok`. Otherwise `503`. The body is only `ok`/`fail` per check:

```json
{ "status": "not_ready",
  "checks": { "database": "fail", "schema": "fail", "artifactStorage": "ok", "renderer": "ok", "lifecycle": "ok" } }
```

Use it for **traffic decisions** (load balancer, smoke tests, deploy gates).
Never use it as a restart trigger.

### `GET /health/dependencies`: principal with scope `service:health:dependencies`

Always `200` when authorized. The shape is the contract's `DependencyHealth`:

| Field | Meaning |
|---|---|
| `service.startedAt` | Process start time |
| `schema.expectedHead` / `actualHead` | Expected migration vs. last applied one. While the database is unreachable `actualHead` keeps the last observed value (`null` if never observed) |
| `dependencies.<name>.status` | `up` / `down`. `database` is `degraded` + `schema_mismatch` when connected but not at head. `emailProvider` is `disabled` / `up` / `degraded` |
| `dependencies.<name>.failureCategory` | Stable sanitized reason: `unreachable`, `timeout`, `authentication`, `permission`, `schema_mismatch`, `storage_full`, `storage_read_only`, `integrity`, `renderer_unavailable`, `provider_error` |
| `dependencies.<name>.lastSuccessAt` | Time of the last successful probe |
| `workers.*` | `enabled`, `lastPollAt`, and the backlog of work due now, measured in PostgreSQL by persistence-gated ticks (`issuance`, `expiry`: R1.6D; `emailDelivery`: R1.6B). Before the first measurement `0` / `null`. Definitions: [operational-hardening.md §4](operational-hardening.md#4-queue-metrics-healthdependencies-workers) |

The task brief's `reasonCode` / `lastSuccessfulCheckAt` are the frozen
contract's `failureCategory` / `lastSuccessAt`.

Never returned: DSNs, hosts, ports, database names, credentials, filesystem
paths, stack traces, raw driver errors.

Authentication uses the principal registry ([principals.md](principals.md)):
`401 unauthenticated` without a valid credential, `403 forbidden` without
the scope.

### `GET /health`: deprecated

Liveness alias kept for existing probes: `200 {"status":"ok","service","version"}`.
It no longer checks the database.

## 5. Dependency monitor

`src/application/health/dependency-monitor.ts` is the single owner of
readiness. Health routes, the business-route gate and the background jobs read
the same state, so no two components can disagree.

- **Single-flight:** at most one probe cycle runs at a time. Concurrent
  callers join it.
- **Bounded:** each probe is raced against `HEALTH_PROBE_TIMEOUT_MS`. The
  database probe also sets its connect, query and statement timeouts to the
  same value, on a dedicated short-lived connection, so a dead database
  cannot park work in the request pool.
- **Cadence:** `HEALTH_PROBE_INTERVAL_MS` while healthy. While unready the
  monitor retries with exponential backoff from `HEALTH_PROBE_RETRY_MIN_MS`
  up to `HEALTH_PROBE_RETRY_MAX_MS`.
- **Early signal:** a request that hits a connection error, or a pooled
  connection that dies while idle, asks for an extra cycle. This is
  throttled to one per `HEALTH_PROBE_RETRY_MIN_MS`.
- **Pool safety:** the `pg.Pool` has an `'error'` listener. Without it, an
  idle connection killed by a database restart is an unhandled `'error'`
  event and kills the process. That was a crash path before R1.3.

Probes:

| Dependency | Probe | Side effects |
|---|---|---|
| database + schema | connect, `to_regclass('public.schema_migrations')`, `select name … order by id` | none (read-only) |
| artifact storage | `mkdir -p <root>/.health`, write a random nonce to `probe-<pid>-<uuid>.tmp`, read it back and compare, delete it | probe file is always deleted in `finally`. Probe files older than 60 s (left by a crashed process) are swept. `.health/` is outside `quotes/`, so it is never a customer artifact and orphan cleanup never sees it |
| renderer | render a one-line PDF in memory with the production printer, fonts and brand logo; check the `%PDF-` header | none (nothing persisted) |

## 6. Business traffic while unready

Every business route sits behind an `onRequest` gate on the **capability
it declares** (R1.6D, [operational-hardening.md §1](operational-hardening.md#1-capability-model)):
reads, drafts, cancel and delivery requests need only lifecycle + database +
schema; `GET …/document` also needs storage; issuance also needs storage and
the renderer. When the gate is closed, no handler, repository or storage
call runs. Checks run in this order: lifecycle → database → schema →
storage → renderer. `/health/ready` keeps its full-issuance meaning.
`/v1/*` answers `410 api_version_retired` without any gate.

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5

{"error":{"code":"dependency_unavailable","message":"A required dependency is unavailable; nothing was committed.","details":{"dependency":"database","retryable":true}}}
```

```json
{"error":{"code":"schema_not_ready","message":"The database schema is not at the expected migration head."}}
```

A request can pass the gate just before an outage is observed. In that case
connection-class driver errors (`ECONNREFUSED`, `57P01`, "Connection
terminated", …) map to the same `503 dependency_unavailable`, and
missing-relation errors (`42P01`, `3F000`) map to `503 schema_not_ready`.
They are never a raw driver error or a `500`. Quote semantics are unchanged.

## 7. Graceful shutdown

On `SIGTERM` / `SIGINT`, also used after a class A fatal:

1. `shutdown.started`: lifecycle → shutting down. Readiness → `503`,
   and the business gate rejects new requests.
2. Stop the dependency monitor and background jobs. In-flight iterations are
   awaited (Fastify `preClose`).
3. Close Fastify: stop accepting connections and drain in-flight requests.
4. Close the PostgreSQL pool (Fastify `onClose`).
5. `shutdown.completed` with `outcome` and `durationMs`. Exit `0`.

The whole sequence is raced against `APP_SHUTDOWN_TIMEOUT_MS`. If a request
or job does not finish in time, `outcome: "timed_out"` is logged and the
process exits `1` anyway. It cannot hang. A second signal joins the shutdown
already in progress.

## 8. Background jobs

R1.4 retired the V1 jobs (V1 expiry, V1 email outbox, V1 orphan cleanup)
together with the V1 persistence model. `BackgroundJobManager` currently runs
no jobs; the V2 issuance worker and expiry materialization (R1.5) and email
delivery (R1.6) register there. Since R1.5B3 the issuance worker
and its deadline sweep run in every process
([issuance-execution.md](issuance-execution.md)); the storage probe is the
content-addressed store's (temp write/fsync/link/read/remove in
`artifacts/tmp`). Every job runs only while the monitor reports
ready, except the issuance deadline sweep, which needs only the database and
schema (`isPersistenceReady()`). While unready, each job logs one `job.paused` and one `job.resumed` on
recovery, not one line per skipped tick. Iteration failures log `job.failed`
with the error name and driver code only, because driver messages can echo
row values.

## 9. Operational log events

Structured (pino JSON) with an `event` field. Only **state transitions** are
logged. A long outage produces one `dependency.down`, not one per poll.

| Event | Level | Fields |
|---|---|---|
| `runtime.started` | info | `service`, `version`, `ready` |
| `runtime.ready` / `runtime.unready` | info / warn | `failing` (check names) |
| `dependency.down` | warn | `dependency`, `failureCategory`. Logged again only if the category changes |
| `dependency.recovered` | info | `dependency`, `downForMs` |
| `schema.not_ready` | warn | `state` (`SCHEMA_MISSING` / `SCHEMA_BEHIND` / `SCHEMA_AHEAD_OR_UNKNOWN` / `SCHEMA_INTEGRITY_MISMATCH` / `SCHEMA_INTEGRITY_UNVERIFIED`), `expectedHead`, `actualHead` |
| `job.paused` / `job.resumed` / `job.failed` | warn / info / error | `job` |
| `shutdown.started` / `shutdown.completed` | info (error if not completed) | `reason`, `outcome`, `durationMs` |
| `runtime.config_invalid` / `runtime.init_failed` / `runtime.bind_failed` / `runtime.fatal` | fatal | sanitized |

Never logged by these paths: credentials, DSNs, auth tokens, customer PII.

## 10. Schema head

- `EXPECTED_SCHEMA_HEAD` is the last entry of the generated migration
  manifest (`migration-manifest.ts`, names plus SHA-256), currently
  `000009_quote_snapshot_child_insert_guard`.
- At startup the packaged migration files must equal the manifest exactly:
  names, order and checksums. This catches a build that forgot to copy
  migrations, an edited historical migration, or a code/migration mismatch.
  Otherwise exit 1.
- At runtime the applied list (`public.schema_migrations`, by `id`) is
  compared with the packaged ordered list:

| Applied vs expected | State | Ready? |
|---|---|---|
| identical | `READY` | yes |
| table absent or empty | `SCHEMA_MISSING` | no |
| strict prefix | `SCHEMA_BEHIND` | no |
| extra, foreign or reordered entries | `SCHEMA_AHEAD_OR_UNKNOWN` | no |
| identical, but a recorded checksum differs from the packaged file | `SCHEMA_INTEGRITY_MISMATCH` | no |
| identical, but an applied migration has no recorded checksum | `SCHEMA_INTEGRITY_UNVERIFIED` | no |
| cannot connect | `DB_UNAVAILABLE` | no |

`npm run db:check` (`db:check:runtime` in `dist/`) runs the same comparison
and exits `0` only for `READY` (`2` otherwise).

**Adding a migration:** add the file and run `npm run db:manifest` in the
same change. The integrity model, roles and V2 schema are documented in
[v2-persistence.md](v2-persistence.md).

## 11. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_SSL_MODE` | `disable` | `disable`, legacy unauthenticated `require`, or authenticated `verify-full`; production permits loopback plaintext or `verify-full` only |
| `DATABASE_SSL_CA_FILE` | (unset) | Required mounted CA PEM bundle for `verify-full`, max 256 KiB; same policy for maintenance/runtime; [details](database-transport.md) |
| `HEALTH_PROBE_TIMEOUT_MS` | `HEALTHCHECK_DATABASE_TIMEOUT_MS` (2000) | Bound per probe (100–30000) |
| `HEALTH_PROBE_INTERVAL_MS` | 10000 | Cadence while healthy |
| `HEALTH_PROBE_RETRY_MIN_MS` | 1000 | First retry while unready |
| `HEALTH_PROBE_RETRY_MAX_MS` | 30000 | Backoff cap. Must be ≥ the minimum |
| `APP_SHUTDOWN_TIMEOUT_MS` | 10000 | Hard shutdown deadline |
| `QUOTE_DOCUMENT_STORAGE_ROOT` | (required) | Single-host filesystem root. Must be a persistent volume |
| `MIGRATION_DATABASE_URL` | falls back to `DATABASE_URL` | Read **only** by `db:migrate`, `db:check`, `db:grants` and `documents:verify` (migration principal). The server never reads it |
| `HEALTHCHECK_DATABASE_TIMEOUT_MS` | 2000 | Deprecated alias of `HEALTH_PROBE_TIMEOUT_MS` |
| `QUOTE_ISSUANCE_LEASE_MS`, `QUOTE_ISSUANCE_POLL_INTERVAL_MS`, `QUOTE_ISSUANCE_DEADLINE_MS`, `QUOTE_ISSUANCE_SYNC_BUDGET_MS` | 60000, 2000, 86400000, 5000 | Issuance operation (contract ranges, [issuance-operation-core.md §11](issuance-operation-core.md#11-configuration)) |

`db:migrate` / `db:check` need only database configuration. The V1-only keys
(`QUOTE_DOCUMENT_REF_SECRET` and the V1 expiry, cleanup and email worker
settings) were removed in R1.4; leftover values are ignored.

## 12. Local bootstrap

```bash
npm ci
npm run db:compose:up                 # disposable PostgreSQL 16 on :5432
cp .env.example .env                  # email provider is disabled by default
# Replace database placeholders with local test credentials and configure the principal registry.
npm run db:check                      # → SCHEMA_MISSING, exit 2 (expected)
npm run db:migrate -- up              # explicit DDL step
npm run db:check                      # → READY, exit 0
npm run dev
curl -i localhost:3000/health/live    # 200
curl -i localhost:3000/health/ready   # 200
```

Rule: **migrations run before the runtime, as a separate explicit command.**
If you start the service first, it runs live and not ready with
`schema_not_ready` until you migrate. After `db:migrate`, readiness turns
green without a restart.

## 13. Deferred (not in R1.3)

| Item | Why deferred | Target |
|---|---|---|
| ~~Separate DB roles and grants~~ | **Done in R1.4** (`000008`, [v2-persistence.md §6](v2-persistence.md#6-database-roles-and-grants)) | — |
| ~~Migration file checksums~~ | **Done in R1.4** (`000006`, [v2-persistence.md §3](v2-persistence.md#3-migration-integrity)) | — |
| ~~`service:health:dependencies` scope enforcement~~ | **Done in R1.5A** ([principals.md](principals.md)) | — |
| ~~Worker `queueDepth` / `oldestPendingAgeSeconds`~~ | **Done in R1.6B/R1.6D** ([operational-hardening.md §4](operational-hardening.md#4-queue-metrics-healthdependencies-workers)) | — |
| Email provider active probe | Health checks must not call Gmail. Status is derived from delivery outcomes | — |
| Backup/restore rehearsal (DB + document root) | Recovery model documented in R1.4 ([v2-persistence.md §7](v2-persistence.md#7-recovery-model)); rehearsal needs the production environment | R1.7 |
| `requestId` in error bodies | V2 error envelope | R1.5 |
