# Runbook — Degraded Operation and Integrity Alerts (R1.6D)

What still works when one dependency is down, and what to do when the
integrity job reports a document problem. Background:
[operational-hardening.md](../operational-hardening.md). No credential or
production value appears here.

Signals to watch:

- `GET /health/ready` (no auth). `503` means this instance cannot run the
  **full issuance path**. That does not mean everything is down: see below.
- `GET /health/dependencies` (`service:health:dependencies`): per-dependency
  `status` / `failureCategory`, and `workers.{issuance,expiry,emailDelivery}`
  backlog (`queueDepth`, `oldestPendingAgeSeconds`, `lastPollAt`).
- Logs: `dependency.down` / `dependency.recovered`, `job.paused` /
  `job.resumed`, `document.integrity_failed`,
  `document.integrity_scan_completed`, `expiry.materialized`.

Do not restart the process to "fix" a dependency outage. Every gate reopens
by itself when the probe recovers (Domain §13). A restart only loses the
in-memory `emailProvider` status.

## 1. Renderer outage

Signal: readiness `503` with `renderer: "fail"`, and `dependency.down`
with `dependency: "renderer"`. The usual cause is missing or altered pinned
fonts or assets in the deployed image, or a runtime that differs from the
renderer profile.

Still available:

- every read, list, operation, audit and idempotency lookup;
- `GET …/document`, which serves the committed bytes and never renders;
- drafts, cancel, delivery requests and reads;
- jobs: email sending, expiry, the deadline sweep, the delivery sweep and
  the integrity job.

Unavailable:

- `POST /v2/quotes` and `POST …/issue` answer `503 dependency_unavailable`
  (`dependency: renderer`); nothing is committed;
- the issuance worker is paused.

Already-accepted operations wait. `workers.issuance.queueDepth` shows the
backlog. An operation that passes its deadline is failed by the deadline
sweep (`issuance_deadline_exceeded`). Recover it with `issuance:retry`
after the fix (see [operator-controls.md](operator-controls.md)).

Action: redeploy the correct image. Readiness returns by itself.

## 2. Artifact storage outage

Signal: readiness `503` with `artifactStorage: "fail"`. The failure category
is `unreachable`, `permission`, `storage_full` or `storage_read_only`.

Still available:

- quote reads, list, operation, audit and idempotency lookup;
- drafts and cancel;
- delivery requests (`202`) and reads;
- jobs: expiry, the deadline sweep and the delivery sweep.

Unavailable (`503 dependency_unavailable`, `dependency: artifactStorage`):

- `GET …/document`;
- create-and-issue and issue.

Paused: the issuance worker, email sending (queued deliveries wait as
`pending`) and the integrity job.

Action: restore the volume (mount, permissions, space). Do **not** run
`documents:repair` for an outage: missing files on an unmounted volume are
not lost artifacts. The integrity job deliberately reports nothing per
artifact for a scan interrupted by a storage outage.

## 3. Email provider outage (Gmail)

Signal: `/health/dependencies` `emailProvider` is `down` or `degraded`
(category `authentication`, `unreachable` or `provider_error`).
`delivery.attempt_failed` and `delivery.outcome_unknown` appear in the logs.

Readiness is **unaffected** (email is never part of it).

Still available:

- every quote read and document read;
- issuance;
- delivery requests (`202`, queued);
- the send runner keeps trying under the R1.6B rules: retryable failures
  back off, and ambiguous ones become `unknown` and are never retried.

Action: fix the credentials or quota. Queued deliveries go out on their next
due attempt. `unknown` deliveries need manual review (search the sending
mailbox by `Message-ID`). There is no automatic reconciliation.

Provider **disabled** (`QUOTE_EMAIL_PROVIDER=disabled`): new delivery
requests answer `503` with `dependency: email_provider` and
`retryable: false`. Replays of already-bound keys still answer their bound
result.

## 4. Database outage

Signal: readiness `503` with `database: "fail"`. Liveness stays `200`.

Unavailable: every business route answers `503 dependency_unavailable`
(`dependency: database`) and every job pauses. Nothing is mutated.

Action: restore PostgreSQL. The pool reconnects with bounded backoff, and
jobs resume where the database says they are.

## 5. Integrity alert (`document.integrity_failed`)

The opt-in job (`QUOTE_INTEGRITY_CHECK_INTERVAL_MS > 0`) only **detects**.
Each problem line carries `quoteId`, `documentId`, `origin`, `category`
(`MISSING`, `HASH_MISMATCH`, `LENGTH_MISMATCH`, `READ_FAILED`, `KEY_INVALID`
or `OVERSIZED`) and `pdfSha256`. Readiness is not affected. Only that quote's
`GET …/document` answers `503 document_storage_failed`.

1. **Confirm** with the operator command against the same database and
   storage root:
   `npm run documents:verify:runtime`. Exit `2` lists the problems with
   their categories. It is read only.
2. **Investigate** before touching anything:
   - Is storage healthy? (see §2). A whole-volume `MISSING` is an outage,
     not a lost artifact.
   - Is a backup copy of the exact bytes available? A file whose SHA-256
     equals the manifest's `pdfSha256` may be restored to the storage key.
     Any other bytes are never served.
   - `HASH_MISMATCH` or `LENGTH_MISMATCH`: different bytes sit at the content
     address. That is an incident. Preserve them for analysis; nothing
     overwrites them automatically.
3. **Repair only if appropriate:** `npm run documents:repair:runtime -- --quote <id> --operator <operatorId>`
   runs as a dry run. Add `--yes` to apply. It re-renders from the frozen
   snapshot and publishes **only** bytes that reproduce `pdfSha256`. It never
   changes the manifest. It refuses migrated V1 manifests
   (`NOT_REPAIRABLE_LEGACY`) and different bytes already at the address
   (`INTEGRITY_CONFLICT`). See
   [operator-controls.md](operator-controls.md).
4. Re-run `documents:verify:runtime` and confirm the next scan's
   `document.integrity_scan_completed` shows `problems: 0`.

## 6. Expiry lag

`workers.expiry.queueDepth > 0` for longer than a few cadences means stored
`issued` quotes past their validity are not being materialized. Reads are
**still correct**: they project `expired` with the exact boundary. Check:

- `job.paused` for `expiry` (database or schema problem);
- `job.failed` (the error code is in the log line);
- long-held quote row locks (the job skips locked quotes and retries next
  tick).

Each materialization writes one `quote.expired` audit event with
`expiredAt = validUntilExclusive`, however late it runs.
