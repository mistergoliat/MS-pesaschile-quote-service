# Runbook (DRAFT): Quote Service production bootstrap

> **Status: DRAFT, not approved for production use.** R1.3 makes the
> runtime survive dependency outages. It does **not** make the Quote Service
> production-ready: database role separation, backup/restore and the V2
> domain are still outstanding (see `docs/runtime-lifecycle.md` §13). Do not
> run this against production until the owner readiness gate (R1.7) passes.

Lifecycle and health semantics: [`docs/runtime-lifecycle.md`](../runtime-lifecycle.md).

## Order of operations

```
provision DB → run explicit migration command → validate schema head
→ start service → verify live → verify ready
```

Never reorder. The service never migrates by itself.

### 0. Prerequisites

- Build artifact from `npm run build` (`dist/` includes
  `dist/infrastructure/persistence/postgres/migrations/*.cjs`), or the Docker image.
- Secrets in the host's secret store, never in shell history:
  `DATABASE_URL`, `MIGRATION_DATABASE_URL` (optional), `SERVICE_AUTH_TOKEN`
  (≥ 16 chars), `QUOTE_DOCUMENT_REF_SECRET` (≥ 32 chars).
- A persistent volume for `QUOTE_DOCUMENT_STORAGE_ROOT`, owned by the service user.
- `QUOTE_EMAIL_PROVIDER=disabled` unless email has been approved separately.
- `QUOTE_EXPIRATION_SCHEDULER_ENABLED=false` and
  `QUOTE_DOCUMENT_CLEANUP_ENABLED=false` unless approved separately.

### 1. Provision the database

Create the database and the role(s). Until R1.4 introduces separate grants,
the runtime and migration roles may be the same role. If they differ, set
`MIGRATION_DATABASE_URL` for steps 2–3 only.

### 2. Run the migration command (explicit DDL)

```bash
NODE_ENV=production node dist/scripts/migrate.js up      # npm run db:migrate:runtime
```

Expected output: `{"status":"ok","direction":"up"}` and exit 0. Any other
exit: stop and investigate. Do not start the service.

### 3. Validate the schema head

```bash
node dist/scripts/db-check.js                             # npm run db:check:runtime
```

Proceed only if the exit code is 0 and the output shows:

```json
{ "status": "ok", "database": "ok",
  "schema": { "state": "READY", "expectedHead": "000005_quote_line_shipping", "actualHead": "000005_quote_line_shipping" } }
```

| Output | Meaning | Action |
|---|---|---|
| `database: unreachable/timeout` | network / host | fix connectivity, rerun step 3 |
| `database: authentication` | credentials | fix secret, rerun step 3 |
| `SCHEMA_MISSING` / `SCHEMA_BEHIND` | not migrated | rerun step 2 |
| `SCHEMA_AHEAD_OR_UNKNOWN` | DB migrated by newer or foreign code | **stop**. Do not start this build against it |

### 4. Start the service

Supervisor settings (PM2 example):

```js
// ecosystem.config.cjs (example)
{ name: "quote-service", script: "dist/server.js",
  max_restarts: 5, exp_backoff_restart_delay: 1000, kill_timeout: 15000 }
```

- `kill_timeout` must exceed `APP_SHUTDOWN_TIMEOUT_MS` (default 10 s).
- Restarts are for class A exits only (bad config, bad package, port taken)
  and are capped. **Alert on any restart.** A dependency outage never
  causes one.
- Liveness checks use `/health/live`. Never use `/health/ready` for restart
  decisions.

### 5. Verify live

```bash
curl -fsS http://127.0.0.1:3000/health/live         # {"status":"live"}
```

If this fails, the process is not running or not bound. Check for
`runtime.config_invalid`, `runtime.init_failed` or `runtime.bind_failed` in the logs.

### 6. Verify ready

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health/ready   # 200
curl -sS -H "Authorization: Bearer $SERVICE_AUTH_TOKEN" \
  http://127.0.0.1:3000/health/dependencies
```

If ready is `503`, read `checks` and `/health/dependencies`, fix the failing
dependency, and wait. Readiness recovers within `HEALTH_PROBE_RETRY_MAX_MS`
(default 30 s) without a restart.

Only route traffic once ready returns `200`.

## Operating notes

- **Database outage:** expect `dependency.down` → `runtime.unready` in the
  logs. Callers receive `503 dependency_unavailable` with `Retry-After: 5`.
  Do not restart the service. When the DB returns, expect
  `dependency.recovered` → `runtime.ready`.
- **Deploying a build with a new migration (R1.4+):** run steps 2–3 with the
  new build *before* switching processes. An old process seeing a newer
  schema reports `SCHEMA_AHEAD_OR_UNKNOWN` and goes not ready, so plan the
  cut-over accordingly.
- **Shutdown:** `SIGTERM` drains within `APP_SHUTDOWN_TIMEOUT_MS`. Look for
  `shutdown.completed` with `outcome: "completed"`. `timed_out` means a
  request or job was cut off.
