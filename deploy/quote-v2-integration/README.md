# Quote V2 — EC2 integration deployment procedure (R1.7B-G1)

Status: **deployed 2026-10-08 (R1.7B-G2)**, synthetic E2E passed, see
`docs/reviews/R1.7B-G1_GREENFIELD_EC2_DEPLOYMENT_REPORT.md`. Secrets were generated
with `provision-secrets.sh`; synthetic checks use `g1-e2e.mjs run|verify <secretsDir> <stateFile>`.
Integration only: no customer traffic, Gmail disabled, no public route.

Deployment identity: `quote-v2-integration` (containers, networks, volumes, compose project).

| Resource | Name | Notes |
|---|---|---|
| App container | `quote-v2-integration` | image `quote-v2-integration:6735352`, uid 999 `nodeapp` |
| DB container | `quote-v2-integration-postgres` | `postgres:16-alpine` (already on host), no published port |
| Networks | `quote-v2-integration-db` (internal), `quote-v2-integration-edge` | DB has no egress |
| Volumes | `quote-v2-integration-pgdata`, `quote-v2-integration-documents` | new, empty; never the V1 volume/root |
| HTTP | `127.0.0.1:4020` → container `3000` | loopback only; SSH tunnel for access |
| Database | `quote_v2_integration` | owner `quote_migrator`; runtime login `quote_app` ∈ `quote_runtime` |
| Secrets dir | `${QUOTE_V2_SECRETS_DIR}` (e.g. `~/.config/quote-v2-integration`) | 0700; files 0600 (or 0400 owned by the reading uid) |

## Gates before step 1

1. Disk: `df -B1M /` shows ≥ 3,000 MB available (owner minimum; more preferred).
2. Owner authorizes generating the greenfield secrets **on the host** (step 2).
   No V1 value is reused; the V1 `.env` contains no principal registry and
   several retired settings.

## Steps

All commands run on the host as `ec2-user`. Secret values are written straight
to files and are never echoed, logged or pasted into chat. Use `set +o history`
in the session.

1. **Image.** From the workstation, stream the verified image (no tarball on host):
   `docker save quote-v2-integration:6735352 | ssh <host> docker load`, under a host-side
   watchdog that kills the load if free disk drops below 500 MB. The measured peak for
   6735352 was 1,213 MB (staging + extraction); check `df` first. Verify on host: image id, `node -v` = `v24.14.0`, `process.versions.zlib` =
   `1.3.1-e00f703`, migration manifest = 9 entries ending `000009_…`.
2. **Secrets:** run `provision-secrets.sh`. It does everything below, prints no value, and
   refuses to run if the directory exists (fail-closed, not idempotent: after a partial
   failure, inspect and remove the directory before re-running). Contents of
   `${QUOTE_V2_SECRETS_DIR}` (`umask 077`):
   - `pg-superuser-password`, `migrator-password`, `app-password`: `openssl rand -hex 32`.
   - `pg-tls/`: private CA (`basicConstraints=critical,CA:TRUE`), server cert with
     `subjectAltName=DNS:quote-v2-integration-postgres`, `extendedKeyUsage=serverAuth`.
     Delete `ca.key` after signing. `server.key` → owner uid 70, mode 0600 (`sudo chown 70:70`).
     `ca.crt`, `server.crt` → 0644.
   - `runtime.secret.env`: `DATABASE_URL=postgres://quote_app:<app-password>@quote-v2-integration-postgres:5432/quote_v2_integration`.
   - `migration.secret.env`: `MIGRATION_DATABASE_URL=postgres://quote_migrator:<migrator-password>@quote-v2-integration-postgres:5432/quote_v2_integration`.
   - Principals: run `node dist/scripts/generate-principal-token.js` inside the image
     twice; store each token in its own 0600 file (`token-synthetic`, `token-monitor`);
     write only the hashes into `principals.json`:
     - `quote-g1-synthetic` (service): `quotes:draft:write`, `quotes:issue`, `quotes:create`, `quotes:read`, `quotes:document:read`;
     - `quote-g1-monitor` (service): `service:health:dependencies`.
     `principals.json` → `sudo chown 999:999`, mode 0400.
3. **Database only:** `docker compose -p quote-v2-integration up -d postgres`; wait for healthy.
4. **Roles + DB** via the container socket (`docker exec -i -u postgres … psql -v ON_ERROR_STOP=1`).
   The SQL, including the two passwords read from their files, is written to psql's
   **stdin** (never argv). `log_statement` is off, so the passwords are not logged:
   ```sql
   create role quote_runtime nologin;
   create role quote_migrator login password '<migrator-password>';
   create role quote_app login password '<app-password>' in role quote_runtime;
   create database quote_v2_integration owner quote_migrator;
   revoke all on database quote_v2_integration from public;
   grant connect on database quote_v2_integration to quote_runtime;
   ```
5. **Migrate** (one-shot container on the internal network, migration credential only):
   `docker run --rm --network quote-v2-integration-db --env-file <secrets>/migration.secret.env -e NODE_ENV=production -e DATABASE_SSL_MODE=verify-full -e DATABASE_SSL_CA_FILE=/run/quote-tls/ca.crt -v <secrets>/pg-tls/ca.crt:/run/quote-tls/ca.crt:ro quote-v2-integration:6735352 node dist/scripts/migrate.js up`
   → `{"status":"ok","direction":"up"}`. Then `db-check.js` must show `READY`
   with `actualHead = 000009_quote_snapshot_child_insert_guard`.
   Run `apply-runtime-grants.js` only if db-check reports missing grants.
6. **Least privilege check** as `quote_app` over TLS: `create table g1_probe(x int)` must
   fail with SQLSTATE 42501; `select` on `pg_stat_ssl` for the session shows `ssl = t`.
7. **Start app:** `docker compose -p quote-v2-integration up -d quote`. Check
   `/health/live`, the full `/health/ready` payload and `/health/dependencies`
   (monitor token) at `127.0.0.1:4020`.
8. **Synthetic E2E** with the synthetic principal only (see the report §O–§T).
9. **Documents:** `verify-document-artifacts.js` read-only (never `--record-byte-length`).

## Certificate lifecycle (DB TLS)

The private CA signing key was **destroyed** right after signing, so no CA key exists anywhere.

- The CA and the server certificate both expire after 365 days (2027-10-08 for the current
  pair). Neither can be renewed or re-signed: renewal means **a new CA and a new server certificate**.
- Rotation (planned Quote-only maintenance):
  1. Generate a new CA and server certificate exactly as `provision-secrets.sh` does, with the same SAN.
  2. Replace `pg-tls/{ca.crt,server.crt,server.key}` (`server.key` 0400, uid 70).
  3. Run `docker compose -p quote-v2-integration restart postgres quote`.

  Every client that trusts the old `ca.crt` (the app, and the one-shot migrate/check/verify
  containers) needs the new `ca.crt` in the same window. To get an overlap period,
  concatenate both CAs into `ca.crt` during the change.
- A compromised `server.key` is handled the same way. It needs a new CA as well, because the
  old CA cannot issue a replacement.
- Track expiry with `openssl x509 -in pg-tls/server.crt -noout -enddate`.

## Never

- Publish the DB port, attach the DB to `edge`, or add an nginx route.
- Reuse `ms-pesaschile-quote-service_postgres-data`, the V1 `var/quote-documents`, or any V1 setting.
- Touch R4's Postgres, CRM MariaDB, PM2 apps or nginx.
- Set `QUOTE_EMAIL_PROVIDER=gmail`.
