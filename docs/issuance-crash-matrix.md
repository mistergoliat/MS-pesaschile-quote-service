# Quote Service — Issuance Crash Matrix (R1.5B4)

This is the evidence that durability never depends on a `finally` block. Each
crash below kills a **separate OS process** (SIGKILL, or `docker kill` in the
Linux image) at a named point. Recovery is a fresh process, and leases expire
in PostgreSQL. Normative behaviour:
[Idempotency §4](v2/QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md#4-issuance-operation-lease-fencing-and-recovery),
state machine T5/T6/T12. Background:
[issuance-execution.md §5](issuance-execution.md#5-crash-residue).

## 1. Failure-injection harness

- **Checkpoints** (`application/quote-v2/issuance-failpoints.ts`):
  `after_acceptance_commit`, `after_claim`, `after_snapshot_verified`,
  `after_render`, `before_artifact_link`, `after_artifact_published`,
  `before_t5`, `before_t5_commit` (inside the T5 transaction),
  `after_t5_commit`, `before_issuance_response`, `lease_renewal`. Each call
  site is `await failpoints?.reach(...)`, and the default is `undefined`.
- **Only test compositions can supply them:**
  `BuildApplicationOverrides.issuanceFailpoints`. `src/server.ts` passes
  nothing, no environment variable or route maps to it, and
  `test/unit/test-seams.test.ts` enforces this.
- **Test service process** (`test/process/failpoint-server.ts`, outside
  `dist/` and the image). `--halt=<checkpoint>` prints
  `{"event":"failpoint.reached"}` and holds. The test then SIGKILLs it, or
  writes `resume` on stdin. `--suspend-renewals` also holds every lease
  renewal while held, so the process behaves like a suspended holder.
- **Wire-level ambiguity** (`test/helpers/commit-cutting-proxy.ts`): a TCP
  proxy in front of PostgreSQL. On the connection that sent the T5 manifest
  insert, it either drops the `commit` message (outcome A) or forwards it and
  swallows the reply (outcome B). The driver sees a real terminated
  connection during COMMIT.
- **Docker (production image, no failpoint code):** PostgreSQL locks hold
  issuance at the wanted point, then `docker kill`.
  - A `SHARE` lock on `quote_documents` stops T5 at its manifest insert,
    after publication.
  - An `ACCESS EXCLUSIVE` lock on `quote_lines` blocks the durable response
    rebuild after T5 commits. T5 never touches that table.

## 2. Matrix

| # | Window | How (real failure) | Durable state at the crash | Recovery result | Test |
|---|---|---|---|---|---|
| F1 | after acceptance COMMIT, before claim | SIGKILL at `after_acceptance_commit` (poll 60 s, so no claim can race) | quote `issuing`, number allocated, op `pending` g0 | restarted process claims (g1) and issues the **same** quote, number and operation. No client retry | process-crash F1 |
| F2 | after claim | SIGKILL at `after_claim` | op `running` g1, A's lease, `last_error_code` null (no failure write ran) | nothing claims before expiry. After the **real 10 s lease**, another process reclaims g2 and issues. Quote `issuing` during the gap | process-crash F2 |
| F3/F4 | after snapshot verification / after render | SIGKILL | no manifest, no final file, no temp | expire → reclaim → issued | process-crash F3/F4 |
| F5 | temp written and fsync'd, before link | SIGKILL at `before_artifact_link` | one complete `<sha>.<uuid>.tmp`, no final file, no manifest | reclaim issues. The recent temp is kept. A stale (> 1 h) temp is removed by the next start's probe sweep | process-crash F5, temp sweep |
| F6 | final CA file exists, before T5 | SIGKILL at `after_artifact_published`. Docker: `quote_documents` SHARE lock, then `docker kill` | verified file at its content address, no manifest | reclaim re-renders identical bytes, `EEXIST`, verifies, **reuses** (`reused: true`, same inode/mtime), T5 commits once | process-crash F6. Docker phase 17 |
| F7 | inside T5, before COMMIT | SIGKILL at `before_t5_commit` (transaction open) | PostgreSQL rolls back: no manifest, op `running`, quote `issuing` v1, orphan file | reclaim reuses the file and commits once | process-crash F7. Docker phase 17 (blocked insert) |
| F8 | COMMIT outcome unknown | wire cut: A drops COMMIT (rollback); B forwards COMMIT, swallows the reply | A: not committed. B: committed | the repository re-reads: A still ours with no manifest, so the commit is retried once; B succeeded with our manifest, so COMMITTED. Issued once, attempt 1, 201 from durable state. **The process stays alive** | adversarial (in-process); process-crash wire-level (live process) |
| F8' | T5 committed, attempt not yet returned | SIGKILL at `after_t5_commit` | quote `issued`, op `succeeded`, manifest | the same-key retry returns `201` + `Idempotent-Replay`, with the same quote, number, operation and manifest. No new operation or document | process-crash F8/F9 |
| F9 | T5 committed, before HTTP response | SIGKILL at `before_issuance_response`. Docker: `quote_lines` ACCESS EXCLUSIVE, then `docker kill` | as F8' | as F8' | process-crash F8/F9. Docker phase 18 |
| F10 | zombie / stale holder | A held at `before_t5` with renewals held; B is a second live process | A's lease expires in PostgreSQL | B reclaims g2 and commits. A resumes, and its T5 is `STALE_FENCE` with zero effect: one manifest, one succeeded operation, one `quote.issued` | process-crash F10 |

Before the acceptance commit there is nothing durable: acceptance is one
transaction (R1.5A suites), so a crash there leaves no quote, binding or
operation, and a same-key retry is a new acceptance.

**Invariant held in every row:** no crash point can produce an `issued`
quote whose committed manifest names missing or different bytes. The
manifest commits only after the bytes are verified at their final address.
Orphan files and temp files are the only possible residue.

## 3. Outages and deadlines

| Case | Result | Test |
|---|---|---|
| PostgreSQL down (proxy) | live 200, ready 503, business 503 `dependency_unavailable(database)`, no claim, no mutation, process alive. On recovery the pending quote is issued without restart | adversarial |
| storage down (root replaced by a file) past the deadline | attempts paused (readiness gate). The DB-only sweep fails the overdue op with `issuance_deadline_exceeded` (attempt count 0). Quote `issuing`. After recovery the other op issues and the failed one is **never resurrected** | adversarial |
| renderer down past the deadline | same as storage | adversarial |
| A5: unsupported glyph over HTTP | `202`, op `failed` / `document_generation_failed` at once (T12), attempt count stays 1 over 5 ticks, no `attempt_failed`, no deadline substitution, document `409`. T10 is still possible | adversarial |
| connection killed during COMMIT on a live process | before the B4 fix the **process died** (unhandled pg client `error`). After it, the process survives and reconciles | process-crash wire-level |

## 4. Document integrity under failure

| Case | Result | Test |
|---|---|---|
| tampered (same length) | `503 document_storage_failed`, no bytes, quote `issued`, manifest unchanged, signal `HASH_MISMATCH`. The verifier reports `HASH_MISMATCH` | document suite. Docker phase 19 |
| truncated / extended | `503`, `LENGTH_MISMATCH` | document suite. Unit tests |
| missing (disk loss) | `503`, no regeneration (still absent), verifier `MISSING` | document suite. Docker phase 19 |
| restore exact bytes (operator) | served again, byte-exact | document suite |

## 5. Not covered here

Email (R1.6): issuance sends nothing, and every crash test asserts zero
deliveries. Out of scope: retention, orphan deletion (U1), object storage
and the R4 adapter. U2 (tax wording) and U3 (issuer legal identity) remain
open. They do not block technical R1.5 closure, but they block production
readiness (R1.7).
