# Quote Service — Issuance Operation Core (R1.5B1)

Status: **implemented, NOT deployable on its own.** This slice adds the
database-only durable execution core of V2 issuance. It has no render, no
artifact write and no manifest commit, so there is no success path. The worker
is deliberately **not composed into the running application** (§9). Normative
behavior is in the frozen contract: [Idempotency §4](v2/QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md#4-issuance-operation-lease-fencing-and-recovery)
and [state machine T6/T10](v2/QUOTE_V2_STATE_MACHINE.md). This note describes how it is
implemented. Slicing and reuse decisions: [R1.5B0 audit](R1.5B0_ISSUANCE_PRIMITIVE_SALVAGE_AUDIT.md).

No migration was needed: schema head stays `000009_quote_snapshot_child_insert_guard`.

## 1. Modules

| Module | Role |
|---|---|
| `application/quote-v2/issuance-operation.ts` | Repository port, typed results, attempt error codes, `issuanceBackoffMs` |
| `application/quote-v2/issued-snapshot.ts` | Issued snapshot type, `issuedSnapshotHash` (`jcs-sha256-v2`), `SnapshotIntegrityError` |
| `application/quote-v2/issuance-worker.ts` | `IssuanceWorker` (claim loop + attempt controller), `LeaseRenewal`, `IssuanceDeadlineSweeper`, `createWorkerInstanceId` |
| `infrastructure/persistence/postgres/issuance-operations.ts` | `PostgresIssuanceOperationRepository`: claim, renew, fail, deadline sweep, T10 |
| `infrastructure/persistence/postgres/issued-snapshot-loader.ts` | Rebuilds the issued snapshot from frozen rows; pre-render hash check |
| `infrastructure/runtime/issuance-jobs.ts` | Trigger wiring (two `PeriodicJobRunner`s); not called by `buildApplication` |

## 2. Claim and reclaim

`claimNext(leaseOwner)` is one statement: a `FOR UPDATE OF o SKIP LOCKED`
candidate CTE (oldest due first, `limit 1`) feeding an `UPDATE … RETURNING`.
A candidate must be the quote's **current** operation, the quote must be
`issuing`, `now < deadline_at`, and either

- `pending` with `next_attempt_at <= now`, or
- `running` with `lease_expires_at < now` (reclaim; the contract's strict `<`).

The transition sets `running`, `generation + 1`, `attempt_count + 1`,
`lease_owner`, `last_attempt_at = now`, `next_attempt_at = null` and
`lease_expires_at = min(now + lease, deadline_at)`. `last_error_code` is kept,
as in the contract's `operation-issuing` example. A reclaim is the next
generation of the **same** operation: no new operation and no new number.
PostgreSQL is the only coordinator. Under READ COMMITTED, a row that a
concurrent claimer changed after our snapshot is re-checked against the
predicate once locked, so two claimers never both win. `now` is the
database clock at millisecond precision.

## 3. Fencing and lease renewal

The fence is `(operationId, generation, leaseOwner)` plus `status = 'running'`.
Every worker write (`renewLease`, `failAttempt`, and the B3 commit) is
conditioned on all of it. A stale holder gets `STALE_FENCE` and has zero
durable effect. Renewal sets `lease_expires_at = min(now + lease, deadline_at)`
and is refused at or after the deadline (`DEADLINE_REACHED`). A lease
therefore never outlives the absolute deadline. `LeaseRenewal` is a
per-attempt helper, not a periodic job. It renews every `lease/3` on an
unref'd timer. On a stale fence or the deadline it aborts the attempt's
`AbortSignal`. A transient error is retried on the next beat.

**Lock order.** Every transaction that takes both rows locks the quote row
first, then the operation row. That covers cancel, operator retry,
fail-attempt, the deadline sweep and the future B3 commit. Claim and renewal
lock only the operation row and never wait on it, so no deadlock cycle is
possible.

## 4. Attempt failure and backoff

`failAttempt(fence, code)` accepts only `document_generation_failed`,
`document_storage_failed` or `dependency_unavailable`. Exception text is never
persisted: the worker maps an untyped error to `document_generation_failed`.

- Before the deadline: `running → pending`, the lease is cleared,
  `last_error_code` is set, `next_attempt_at = min(now + backoff(attempt_count), deadline_at)`,
  and `quote.issue.attempt_failed` is recorded (`system`, data:
  `errorCode, attempt, generation, retryInMs, nextAttemptAt`).
- At or after the deadline: terminal `failed` with `issuance_deadline_exceeded`,
  `completed_at` set, and `quote.issue.failed` recorded (data adds
  `lastAttemptErrorCode`).

The schedule is `issuanceBackoffMs(n)` = 5 s, 30 s, 2 min, 10 min, 30 min, then
60 min. It is issuance-specific and does not reuse the email schedule. The
quote is never updated: it stays `issuing`, keeps its number and gets no new
operation.

## 5. Deadline sweep (T6)

`failDeadlineExceeded(limit)` selects `pending` operations, and `running` ones
whose lease has expired, with `deadline_at <= now`. Each one is handled in its
own transaction (quote lock, then operation lock, then a re-check): bump
`generation` (fences any zombie), set `failed`, `issuance_deadline_exceeded`
and `completed_at = now`, clear the lease and `next_attempt_at`, and record one
`quote.issue.failed` (`issuing → issuing`). A live lease is never pre-empted.
The quote row, version included, is not touched. The sweep is idempotent:
terminal operations are never selected again. The sweeper logs one
`issuance.deadline_failed` per operation as the operator alert.

## 6. Readiness gating

| Runner | `canRun` | Why |
|---|---|---|
| `issuance` | `DependencyMonitor.isReady()` (database, schema, storage, renderer, lifecycle) | An attempt needs every dependency |
| `issuanceDeadlineSweep` | `DependencyMonitor.isPersistenceReady()` (database up, schema `READY`, not shutting down) | T6 must happen during a storage or renderer outage |

`isPersistenceReady()` is internal. `/health/ready` keeps its all-or-nothing
semantics. Both runners are fixed-delay triggers at
`QUOTE_ISSUANCE_POLL_INTERVAL_MS`, and the database claim decides what runs.
A tick claims at most `maxClaimsPerTick` (default 5) operations, one attempt
at a time. The sweep handles bounded batches. Nothing is logged for an empty
poll.

## 7. Operator retry (T10)

`createOperatorRetry({quoteId, failedOperationId, actorPrincipalId})` runs
under the quote row lock and requires all of the following: the quote is
`issuing`, `failedOperationId` is its current operation, and that operation is
`failed`. It then:

1. recomputes the snapshot hash and requires it to equal the failed
   operation's hash (otherwise `SnapshotIntegrityError`);
2. inserts an `operator_retry` operation (`retry_of_operation_id`, same
   snapshot hash, `generation 0`, `pending`, `next_attempt_at = accepted_at = now`,
   `deadline_at = now + QUOTE_ISSUANCE_DEADLINE_MS`);
3. sets `current_operation_id` and increments the quote version;
4. records `quote.issue.accepted` with `retryOf` (`issuing → issuing`).

Concurrent retries serialize on the quote lock: one wins and the rest get
`INVALID_STATE`. A retry racing a creator cancel (T11) serializes the same
way. If the retry wins, the cancel answers `409 operation_in_progress`. If the
cancel wins, the retry gets `INVALID_STATE` (`cancelled`) and creates nothing.
There is no HTTP or operator tooling yet (R1.6).

## 8. Issued snapshot and hash ownership

The semantic snapshot hash used to be computed from the public read projection
(`readQuote`). A harmless change to a `GET` view would then have changed the
hash of every accepted `issuing` quote. It is now owned by
`issued-snapshot.ts` and its loader. They have their own queries, row types
and formatting, and they cannot import `quote-v2-reads.ts` (an import-graph
test enforces this). Acceptance (T3/T4) and the worker use the same loader and
hash function. Golden tests pin the R1.5A hashes, and integration tests check
the stored hash against a frozen copy of the R1.5A derivation
(`test/helpers/r15a-snapshot-hash.ts`).

Before every attempt body, the worker reloads the snapshot (repeatable read)
and compares its hash with `issuance_operations.snapshot_hash`. On a mismatch
there is no render and no repair: the attempt fails with
`document_generation_failed`, the only contract code that fits, and
`issuance.snapshot_integrity_failed` is logged. The PDF byte hash
(`pdfSha256`) is a separate concept owned by B3.

## 9. Activation status and shutdown

`buildApplication` does **not** call `createIssuanceJobs`, so a B1 build never
claims, fails or sweeps real operations. `/health/dependencies` reports
`workers.issuance.enabled = false` as before. B3 composes the jobs with the
real attempt body. Until then the code is exercised only by tests.

Shutdown: `IssuanceWorker` checks `lifecycle.isShuttingDown` before every
claim. `IssuanceJobs.stop()` stops claiming, aborts the in-flight attempt's
signal and stops both timers. An aborted attempt writes nothing, which is
neither success nor failure. Its lease expires and any process reclaims it.
There is no "shutdown failure" state.

## 10. Commit outcome unknown

When `COMMIT` fails, `CommitOutcomeUnknownError` is never mapped straight to
success or failure. The repository re-reads durable state instead:

- **Claim:** adopt the running operation leased to this process's unique owner
  id if there is one, otherwise `NONE_AVAILABLE`.
- **Renew:** classify by the current fence.
- **Fail:** if the fence still holds, the result is `NOT_APPLIED` (the lease
  expiry recovers it). The same generation in another state means the failure
  was applied. Another generation means `STALE_FENCE`.
- **T10:** `RETRY_CREATED` if the new id is current, otherwise `NOT_APPLIED`.

## 11. Configuration

| Variable | Default | Range | Use |
|---|---|---|---|
| `QUOTE_ISSUANCE_LEASE_MS` | 60000 | 10000–300000 | Lease length; renewed every third |
| `QUOTE_ISSUANCE_POLL_INTERVAL_MS` | 2000 | 500–60000 | Trigger delay of both runners |
| `QUOTE_ISSUANCE_DEADLINE_MS` | 86400000 (24 h) | 1 h–72 h | Copied to `deadline_at` at acceptance and at T10; a later change never moves an accepted operation's deadline |
| `QUOTE_ISSUANCE_SYNC_BUDGET_MS` | 5000 | 0–10000 | Parsed only; the inline path is B3. Not an API invariant (A2) |

## 12. Deferred

| Item | Slice |
|---|---|
| V2 document model, renderer/template v4, Unicode font (U-A/U-B) | B2 |
| Content-addressed publish, real attempt body, fenced manifest commit (T5), inline `syncIssueBudgetMs` path, composition into `buildApplication` | B3 |
| `GET …/document`, integrity job, crash-window failure injection | B4 |
| Operator tooling for T10 | R1.6 |
