# Runbook (DRAFT): Quote Service production bootstrap

> **Status: DRAFT, not approved for production use.** R1.6 is closed and the V2
> API, delivery and operator controls are implemented. The R1.7 production
> readiness gate remains open. Do not run this against production until the
> owner readiness gate passes. R1.7B-S1 adds local security foundations only.

References:

- lifecycle and health: [`docs/runtime-lifecycle.md`](../runtime-lifecycle.md);
- schema, roles, integrity and recovery: [`docs/v2-persistence.md`](../v2-persistence.md).
- transport modes, mounted CA, credential separation and safe diagnostics:
  [`docs/database-transport.md`](../database-transport.md).

## Order of operations

```
backup (if any prior data) → provision roles + DB → run explicit migration command
→ validate schema head → verify legacy artifacts → start service → verify live → verify ready
```

Never reorder. The service never migrates by itself.

### 0. Prerequisites

- Build artifact from `npm run build` (`dist/` includes
  `dist/infrastructure/persistence/postgres/migrations/*.cjs`), or the
  Docker image.
- Secrets in the host's secret store, never in shell history:
  - `MIGRATION_DATABASE_URL`: migration principal;
  - `DATABASE_URL`: runtime login;
  - principal registry (`QUOTE_PRINCIPAL_REGISTRY_FILE` or `QUOTE_PRINCIPAL_REGISTRY_JSON`):
    token hashes and scopes only, see [`docs/principals.md`](../principals.md);
    include a monitoring principal with `service:health:dependencies`.
- PostgreSQL ≥ 15.
- A persistent volume for `QUOTE_DOCUMENT_STORAGE_ROOT`, owned by the
  service user.
- `QUOTE_EMAIL_PROVIDER=disabled` until the separate owner email gate passes.
  R1.6B supports the Gmail adapter, but with the provider disabled requests
  answer `503 email_provider` and queue
  nothing. Delivery execution (worker, provider) is R1.6B.

### 0b. Backup first (any database or document root that may hold V1 data)

`000007` migrates V1 data one-way and drops the V1 tables. Before migrating:

1. Back up the database (`pg_dump -Fc`) and the document root.
2. Verify the restore in an isolated environment.

If anything below fails, the recovery is: **restore → fix → migrate forward.**
Never use `down` in production.

### 1. Provision roles and the database (DBA, out of band)

```sql
create role quote_runtime nologin;                                  -- privilege group
create role quote_migrator login password :'migrator_secret';       -- migration principal
create role quote_app login password :'app_secret' in role quote_runtime;  -- runtime login
create database pesaschile_quote_service owner quote_migrator;
```

The migration principal owns the database. The runtime login owns nothing
and receives only DML through `quote_runtime`.

### 2. Run the migration command (explicit DDL, migration principal)

```bash
MIGRATION_DATABASE_URL=… node dist/scripts/migrate.js up     # npm run db:migrate:runtime
```

Expected output: `{"status":"ok","direction":"up"}` and exit 0.

| Failure | Meaning | Action |
|---|---|---|
| `errorCode=P0001`, `migrationName=000007_quote_v2_persistence`, structured `exceptions` | V1 data violates the frozen mapping; **nothing was changed** | Resolve the listed UUID/code entries on a restored copy, or by an approved data fix, then rerun; raw driver prose is suppressed |
| `MigrationIntegrityError` | An applied migration differs from this build's file | **Stop.** Wrong build or tampered database |
| `MigrationManifestError` | The packaged migrations differ from the build manifest | **Stop.** Broken package |

If `quote_runtime` was created after migrating, run
`node dist/scripts/apply-runtime-grants.js` (`npm run db:grants:runtime`)
as the migration principal.

### 3. Validate the schema head

```bash
MIGRATION_DATABASE_URL=… node dist/scripts/db-check.js       # npm run db:check:runtime
```

Proceed only if the exit code is 0 and the output shows:

```json
{ "status": "ok", "database": "ok",
  "schema": { "state": "READY", "expectedHead": "000009_quote_snapshot_child_insert_guard", "actualHead": "000009_quote_snapshot_child_insert_guard" } }
```

| Output | Meaning | Action |
|---|---|---|
| `database: unreachable/timeout` | network / host | fix connectivity, rerun step 3 |
| `database: authentication` | credentials | fix secret, rerun step 3 |
| `SCHEMA_MISSING` / `SCHEMA_BEHIND` | not migrated | rerun step 2 |
| `SCHEMA_INTEGRITY_UNVERIFIED` | checksum record missing | rerun step 2 (backfills records) |
| `SCHEMA_INTEGRITY_MISMATCH` | applied migration bytes differ | **stop** |
| `SCHEMA_AHEAD_OR_UNKNOWN` | DB migrated by newer or foreign code | **stop**. Do not start this build against it |

### 3b. Verify preserved legacy artifacts (only if V1 data was migrated)

```bash
MIGRATION_DATABASE_URL=… QUOTE_DOCUMENT_STORAGE_ROOT=… \
  node dist/scripts/verify-document-artifacts.js --record-byte-length   # npm run documents:verify:runtime
```

Exit 0: every manifest's file matches its SHA-256. Exit 2 lists `missing` or
`hash_mismatch` documents (ids only). These are data exceptions: restore the
file from backup. **Never regenerate a historical PDF.**

### 4. Start the service

Supervisor settings (PM2 example):

```js
// ecosystem.config.cjs (example)
{ name: "quote-service", script: "dist/server.js",
  max_restarts: 5, exp_backoff_restart_delay: 1000, kill_timeout: 15000 }
```

- `kill_timeout` must exceed `APP_SHUTDOWN_TIMEOUT_MS` (default 10 s).
- Restarts are for class A exits only (bad config, bad package, port taken)
  and are capped. **Alert on any restart.** A dependency outage never causes
  one.
- Liveness checks use `/health/live`. Never use `/health/ready` for restart
  decisions.

### 5. Verify live

```bash
curl -fsS http://127.0.0.1:3000/health/live         # {"status":"live"}
```

If this fails, the process is not running or not bound. Check for
`runtime.config_invalid`, `runtime.init_failed` (for example a packaged
migration manifest mismatch) or `runtime.bind_failed` in the logs.

### 6. Verify ready

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health/ready   # 200
curl -sS -H "Authorization: Bearer $MONITORING_TOKEN" \
  http://127.0.0.1:3000/health/dependencies
```

If ready is `503`, read `checks` and `/health/dependencies`, fix the failing
dependency, and wait. Readiness recovers within `HEALTH_PROBE_RETRY_MAX_MS`
(default 30 s) without a restart.

Only route traffic once ready returns `200`.

## Operating notes

- **Database outage:** expect `dependency.down` → `runtime.unready` in the
  logs. Callers receive `503 dependency_unavailable` with `Retry-After: 5`.
  Do not restart the service. When the database returns, expect
  `dependency.recovered` → `runtime.ready`.
- **Deploying a build with a new migration:** run steps 2–3 with the new
  build *before* switching processes. An old process seeing a newer schema
  reports `SCHEMA_AHEAD_OR_UNKNOWN` and goes not ready, so plan the cut-over
  accordingly.
- **Shutdown:** `SIGTERM` drains within `APP_SHUTDOWN_TIMEOUT_MS`. Look for
  `shutdown.completed` with `outcome: "completed"`. `timed_out` means a
  request or job was cut off.
