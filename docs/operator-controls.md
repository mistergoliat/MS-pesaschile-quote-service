# R1.6C — Operator controls

Status: **CLOSED** on `quote-r1.6c-operator-controls` (base `61c10dc`). Next: R1.6D.
Inputs: [R1.6 pre-flight audit](R1.6_PRE_FLIGHT_OPERATION_DELIVERY_AUDIT.md)
§17 and §25, the frozen V2 contract (state machine T6/T10/T11/T12, Domain
§9.3/§9.4/§11) and amendments A1–A6. Procedures:
[runbooks/operator-controls.md](runbooks/operator-controls.md).

R1.6C adds three host-side commands around the existing V2 runtime. It adds
no HTTP route, no scope, no OpenAPI change, no migration (schema head stays
`000009_quote_snapshot_child_insert_guard`), no audit event type and no
state.

| Command | Effect | Source / runtime |
|---|---|---|
| `issuance:failed` | read-only list of quotes eligible for T10 | `npm run issuance:failed` / `npm run issuance:failed:runtime` |
| `issuance:retry` | T10 through the existing primitive | `npm run issuance:retry` / `npm run issuance:retry:runtime` |
| `documents:repair` | restores the missing bytes of a committed V2 PDF, hash-exact | `npm run documents:repair` / `npm run documents:repair:runtime` |

The `:runtime` variants run the compiled `dist/scripts/*.js` (the Docker
image ships them).

## 1. Operator-plane authority

The state machine defines T10 as "operator procedure (no public endpoint)",
and amendment A4 rules out any cross-principal HTTP mutation. The authority of
these commands is therefore the operator plane:

- host access, and the runtime database credentials and storage root of the
  service (the normal runtime configuration, `loadEnv()`; the commands use
  `DATABASE_URL`, the least-privilege runtime role, never the migration role);
- an explicit operator principal (`--operator`, §3);
- the frozen state checks.

There is no bearer token, no `OPERATOR_MODE`, `ALLOW_REPAIR` or bypass
variable, and no configuration that relaxes a check. Test overrides are
function arguments only (the services take their database, repository,
store, renderer and registry as parameters; the scripts compose the real
ones).

**Schema gate.** Before any query, every command probes the database with the
readiness logic (`PostgresDependencyProbe`): it requires a reachable database
whose applied migrations are exactly this build's manifest, with verified
checksums. Anything else fails closed (`schema_incompatible`, exit 2;
`database_unavailable`, exit 1).

**Structure.** `src/scripts/*.ts` (argv, process exit) →
`src/infrastructure/operator/*.ts` (services; no `process.env`, `argv` or wall
clock) → existing primitives. `operator-command.ts` is the only code that
writes to stdout and sets the exit code.

## 2. Invocation, output and exit codes

Arguments are `--flag value` or a value-less `--yes`. Unknown flags,
positional arguments, repeated flags, missing values and missing required
flags are rejected (`usage_invalid`, exit 2). Rejected values are never
echoed: the message names the flag and the rule only.

Output is one JSON object of ids, codes, versions and hashes. Never customer
data, commercial lines, amounts, recipients, external correlation, PDF bytes,
storage keys, filesystem paths, DSNs or stack traces. Unexpected failures are
reduced to `{"status":"failed","errorName":...}`.

| Exit | Meaning |
|---|---|
| 0 | done (an empty listing; a dry run whose checks passed; retry created; repaired or already intact) |
| 1 | could not run: database or storage unavailable, unexpected failure, or a retry COMMIT that could not be confirmed and did not apply |
| 2 | refused: invocation, configuration, schema, operator principal, snapshot integrity, version or hash mismatch, integrity conflict, legacy V1 document |
| 3 | not applicable: the state does not allow it (already retried, state changed, not `failed`, no document) |

## 3. Operator principal (W6)

`--operator` is validated by one shared helper
(`resolveOperatorPrincipal`, used by `issuance:retry` and `documents:repair`)
against the active principal registry (the same loader as the server,
`PrincipalRegistry.load`, plus a new `find(principalId)` lookup). It must:

- match the principal id pattern;
- not be `system` or `legacy-v1`;
- exist in the registry (presence is what "active" means: the registry has
  no disabled flag, and a registered principal has a live credential);
- have `principalType = "operator"`.

A well-formed but unregistered id, or a `service` principal, is refused
(`OPERATOR_PRINCIPAL_REJECTED` with `principalCheck`
`malformed | reserved | unknown | not_operator`), before any state read.

## 4. `issuance:failed`

```
npm run issuance:failed -- [--quote <uuid>] [--operation <uuid>] [--error <code>] [--limit <1..1000>]
```

Selects quotes with `status = 'issuing'` whose `current_operation_id` names an
operation with `status = 'failed'`. A failed operation that was already
retried is no longer current and is not listed; a failed operation of a quote
cancelled under T11 is not listed (the quote is not `issuing`). Ordered by
`completedAt`; default limit 100; `truncated` says whether more exist.

Item fields: `quoteId`, `quoteNumber`, `version`, `operationId`, `origin`,
`retryOfOperationId`, `lastErrorCode`, `attemptCount`, `acceptedAt`,
`completedAt`, `deadlineAt`, `snapshotHash`.

## 5. `issuance:retry` (T10)

```
npm run issuance:retry -- --quote <uuid> --operation <failedOperationId> --operator <principalId> --reason <code> [--yes]
```

**T10 is not reimplemented.** The command calls
`PostgresIssuanceOperationRepository.createOperatorRetry`, which, under the
quote row lock (lock order quote → operation), requires the quote `issuing`,
the named operation current and `failed`, and the snapshot hash unchanged;
inserts the `operator_retry` operation (same snapshot hash, new deadline,
`pending`); moves `current_operation_id`; bumps the version; and appends
`quote.issue.accepted` (`principalId` = the operator, `data.retryOf`). It
never touches lines, prices, shipping, customer, number or validity.

The only change to the primitive is an optional `reasonCode` written to the
audit `data` (`data.reasonCode`). The frozen `AuditEvent.data` is "minimal
non-PII event data (counts, totals, versions, codes)", so this is within the
contract; the pre-flight audit §17/§30 names it as the one permitted
extension. The code must match `^[a-z][a-z0-9_]{1,63}$` (the contract's
`reasonCode` shape); the primitive itself rejects anything else before
touching the database. There is no free-text note anywhere.

**The failed operation is explicit.** `--operation` must be the quote's
current failed operation; the command never retries "whatever is current".

**Dry run / `--yes`.** Without `--yes` the command validates the operator and
the reason code, reads the quote and its current operation, verifies the
frozen snapshot hash (repeatable-read, read-only transaction) and prints the
plan (`status: "dry_run"`, `dryRun: true`, exit 0). It writes nothing. With
`--yes` it runs the same pre-checks, then T10; the primitive re-checks
everything under the lock, so a state change between the two is reported as
not applicable.

**Idempotency.** No idempotency key. A second run with the same failed
operation finds it no longer current: `not_applicable` / `INVALID_STATE`
(exit 3) with the current operation, and nothing is created.

**Results.** `retry_created` (exit 0: `newOperationId`, `deadlineAt`);
`not_applicable` (exit 3: `QUOTE_NOT_FOUND` or `INVALID_STATE` with
`quoteStatus`, `currentOperationId`, `currentOperationStatus`); `refused`
(exit 2: `SNAPSHOT_INTEGRITY`, `OPERATOR_PRINCIPAL_REJECTED`,
`REASON_CODE_INVALID`).

**Unknown COMMIT outcome.** The primitive re-reads durable state: if the new
operation is the quote's current one it reports `RETRY_CREATED`, otherwise
`NOT_APPLIED`. The command reports `not_applied` (exit 1) and never retries
on its own: re-running is the operator's decision, and the natural
precondition prevents a duplicate.

**Concurrency.** Retries serialize on the quote row: of 8 concurrent
confirmed runs exactly one creates an operation. Against a creator cancel
(T11): if the retry commits first, the cancel answers `409
operation_in_progress`; if the cancel commits first, the retry is not
applicable and creates nothing. No deadlock (same lock order everywhere).

After a retry the issuance worker claims the new operation like any other
(`issuance:failed` no longer lists the quote unless the retry fails too).

## 6. `documents:repair`

```
npm run documents:repair -- --quote <uuid> [--document <documentId>] --operator <principalId> [--yes]
```

Restores **bytes only**, for a committed V2 manifest whose artifact is
missing. The manifest is the authority and is never written. Repair has no
database write at all: no manifest, quote, issuance operation, version,
`issuedAt` or audit change, and it never creates an issuance operation. It is
never automatic: `documents:verify` and the R1.6D integrity job only detect,
and nothing in the codebase calls repair except its own script.

Order of checks (any failure → nothing published):

1. operator principal (W6);
2. manifest and frozen snapshot read in one repeatable-read, read-only
   transaction; `--document`, when given, must be the quote's own manifest
   (`MANIFEST_QUOTE_MISMATCH`); no manifest → `NO_DOCUMENT` (exit 3);
3. `origin = legacy_v1` → refused, `NOT_REPAIRABLE_LEGACY` (exit 2): the V1 renderer
   is retired and V1 PDFs are never reconstructed;
4. manifest consistency: issuing operation `succeeded`, semantic hash equal
   to the operation's, algorithm `jcs-sha256-v2` (`MANIFEST_INCONSISTENT`);
5. storage key exactly `contentAddressedPdfKey(pdfSha256)`
   (`STORAGE_KEY_INVALID`); the command never writes to a caller-provided
   path;
6. current artifact integrity through `readVerified`: `OK` → `already_intact`
   (exit 0, nothing rendered or rewritten); `KEY_INVALID`/`OVERSIZED` →
   refused; `MISSING`, `HASH_MISMATCH`, `LENGTH_MISMATCH`, `READ_FAILED`
   continue;
7. **exact versions**: manifest `rendererVersion` equal to the running
   `RENDERER_VERSION` (`RENDERER_VERSION_MISMATCH`) and `templateVersion`
   equal to `TEMPLATE_VERSION` (`TEMPLATE_VERSION_MISMATCH`). No prefix,
   major or "compatible" match and no override. `RENDERER_VERSION` already
   pins pdfmake/pdfkit, the Node major, zlib and the fonts, and the renderer
   refuses a different stack (`RENDERER_UNAVAILABLE`);
8. the frozen snapshot recomputed to the recorded semantic hash
   (`SNAPSHOT_HASH_MISMATCH`), and the document model built from it with its
   code-owned issuer profile (`DOCUMENT_MODEL_UNAVAILABLE`);
9. render in memory (`RENDER_FAILED`) and require
   `SHA-256(candidate) == manifest.pdfSha256` and the recorded length
   (`HASH_MISMATCH`). **This is the final authority.**

Then:

- **dry run** (no `--yes`): `would_repair` (exit 0) when the address is free;
  `would_conflict` (exit 2) when a file (corrupt or unreadable) occupies it.
  Nothing is published;
- **`--yes`**: publish through the existing write-once
  `FilesystemContentAddressedArtifactStore.publish` (temp, fsync, `link()`
  that never overwrites, verify final bytes), then `readVerified` against the
  manifest and compare with the candidate; only then `repaired`. If identical
  bytes appeared meanwhile, the store reuses them (`already_restored`). If
  different bytes are at the address, the store refuses
  (`INTEGRITY_CONFLICT`, exit 2) and the file is left exactly as it is.

A corrupt file at the content address therefore blocks repair until the
operator quarantines it (moves it out of the storage root, see the runbook).
The command itself never deletes, renames or overwrites a file.

**Audit.** The frozen `AuditEventType` vocabulary has no repair or integrity
event, and repair changes no quote state, so no audit event is written. The
operator record is the command's JSON output (`event: "document.repair"`,
operator, quote, document, `pdfSha256`, versions, outcome), which the operator
keeps with the incident.

## 7. What R1.6C does not do

No HTTP operator endpoint, admin API or scope; no delivery retry, cancel,
`unknown` resolution or delivery listing; no automatic or periodic repair;
no capability readiness, expiry materialization, integrity job or metrics
(R1.6D); no `/v1/*` retirement, deployment, credentials, U2/U3, R4
integration; no email is sent.

## 8. Tests

| Suite | Covers |
|---|---|
| `test/unit/operator-plane.test.ts` | strict argv parsing, unechoed hostile values (BM/BN), W6 (K–Q), primitive rejects free-text reasons, stable exit codes, no route/OpenAPI path/scope (U), server closure never reaches the operator modules, only the scripts call the services, operator modules read no env/argv/clock, repair has no DB write or file removal |
| `test/integration/operator-controls.integration.test.ts` | real PostgreSQL, renderer and store: listing A–J (incl. schema missing/ahead, database down), retry R–AO (T6 and T12 retried and then issued by the real worker, commercial snapshot unchanged, audit exact, dry run, not-applicable states, snapshot tampering, 8-way concurrency, both cancel race orders, no deadlock, commit-unknown both ways), repair AP–BI (byte-exact restore, manifest/quote/operations/audit identical, `GET /document` after repair, version/snapshot/hash refusals, malformed key, wrong manifest, W6, legacy V1 refusal, already intact, integrity conflict never overwritten then repaired after quarantine) and the CLI shells |
| `test/unit/test-seams.test.ts` | the repair/retry/listing scripts added to the "no artifact deletion, no mail sender" closures |
| `scripts/docker-smoke.mjs` phase 21 | the compiled `:runtime` commands in the production image (T6 and T12 failures, listing, retry and issuance, repair of a deleted artifact, conflict on a tampered one, legacy refusal, no email) |
