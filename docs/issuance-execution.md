# Quote Service — Issuance Execution (R1.5B3)

Status: **implemented.** This is the first slice that creates formal V2
PDFs and moves quotes to `issued`. It builds on the
[operation core (B1)](issuance-operation-core.md) and the
[formal document (B2)](formal-document-v2.md). Normative behaviour:
[Idempotency §4](v2/QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md#4-issuance-operation-lease-fencing-and-recovery),
[Domain §9](v2/QUOTE_V2_DOMAIN_CONTRACT.md#9-document), state machine T5/T12 and
amendment **A5** ([freeze record §3c](v2/QUOTE_V2_CONTRACT_FREEZE.md)).
U2 (tax wording) and U3 (issuer RUT/address) remain open: documents are
issued with the provisional B2 template and issuer profile. **Not
production-final.**

## 1. Attempt sequence

```
claim (B1, fenced lease; inline path or periodic worker)
→ reload frozen snapshot, recompute semantic hash = operation.snapshot_hash   (B1)
→ IssuedQuoteDocumentModelV2 (pure)                                            (B2)
→ PDF bytes (pinned renderer)                                                  (B2)
→ content-addressed publish, re-read and verified                              (§2)
→ fenced T5 commit                                                             (§3)
```

The attempt body (`application/quote-v2/issuance-attempt.ts`) checks the
lease signal between steps. Once the lease is lost, or the process is
stopping, it stops before any further business effect. Lease renewal is B1's
`LeaseRenewal`, which renews every lease/3 and is capped at the deadline.
There are no external lookups.

## 2. Content-addressed publication

`FilesystemContentAddressedArtifactStore` (`infrastructure/documents/content-addressed-artifact-store.ts`)
is the only V2 storage surface. It exposes `publish`, `readVerified` (for B4),
`probe` and `sweepTemp`. The key is
`artifacts/sha256/<aa>/<bb>/<sha256>.pdf`. It is exactly the database check
`quote_documents_content_addressed` and carries no quote, number, operation,
time or customer data.

| Step | Detail |
|---|---|
| hash | `pdfSha256 = SHA-256(bytes)` (distinct from the semantic snapshot hash) |
| temp | `artifacts/tmp/<sha>.<uuid>.tmp`, opened `wx`, fully written, `fsync`, closed. Same root, so same filesystem |
| publish | `mkdir -p` the final directory, then `link(temp, final)`: atomic, never overwrites |
| exists | on `EEXIST` the existing file is read and hashed. Identical → reused. Different → `integrity_conflict` (never replaced) |
| cleanup | temp unlinked. Final directory and its parent `fsync`ed (POSIX; Windows cannot fsync a directory, so it is skipped there) |
| verify | the final file is re-read; SHA-256 and length must match. Only then does publication complete |

**No overwrite, no deletion.** Nothing under `artifacts/sha256` is ever
written in place or deleted. The legacy `FilesystemDocumentArtifactStorage`
(`writeBuffer`, `writeText`, `deletePrefix`, `deleteStorageKey`) is not
reachable from any issuance module; a test checks the import closure.
**Portability:** hard links are used on Linux, the production target, and on
Windows NTFS alike. A filesystem without hard links fails the storage
readiness probe rather than falling back to an overwriting rename.

**Temp sweep.** Only exact service temp names (`<sha>.<uuid>.tmp` and
`probe-<uuid>[.link].tmp`) in `artifacts/tmp` older than 1 hour are removed.
A publication holds its temp for milliseconds. The sweep runs from the
storage probe, at most once a minute. Nothing else is ever deleted, and there
is no orphan cleanup (U1).

**Readiness.** The probe does an exclusive temp create, write, fsync, read,
hard link and removal inside `artifacts/tmp`. It never creates a formal
artifact.

## 3. Fenced T5 commit

`PostgresIssuanceOperationRepository.commitIssued` runs one transaction:
quote row lock, then operation row lock (the global lock order). Then:

1. The fence must still hold (`running`, same `generation`, same
   `lease_owner`). The operation must be the quote's current one, and the
   quote must be `issuing`. Otherwise the result is `STALE_FENCE` and nothing
   changes.
2. Insert the `quote_documents` manifest (below).
3. Operation `running → succeeded`: `completed_at`, lease cleared,
   `next_attempt_at` null.
4. Quote `issuing → issued`, `version + 1`, `updated_at`.
5. Audit `quote.issued` (`system`, `issuing → issued`, data: `quoteNumber`,
   `version`, `pdfSha256`, `byteLength`, `rendererVersion`,
   `templateVersion`, `attempts`; `correlationId` is the request's for an
   inline attempt).

The deferred `quotes_require_document` trigger passes, because the manifest
is in the same transaction.

**Manifest:** `document_id`, `quote_id`, `operation_id`, `origin = issuance`,
`content_type = application/pdf`, `semantic_snapshot_hash` (must equal the
operation's), `semantic_hash_algorithm = jcs-sha256-v2`, `pdf_sha256`,
`byte_length`, `renderer_version` (B2 code-owned), `template_version`
(`quote-pdf-template-v4`), `storage_key`, `generated_at` and `committed_at`.
`artifact_ref = sha256:<pdfSha256>` is generated by the database.

**Times.** `generated_at = committed_at = completed_at = quote.updated_at =`
the database time of the T5 commit. The contract example has the same
equality: the document becomes formal at the commit. `issued_at` stays the
frozen acceptance instant and is also the PDF CreationDate.

**Commit outcome unknown.** The repository re-reads the operation and the
manifest; it never guesses:

| Durable state after the re-read | Result |
|---|---|
| Operation `succeeded` at our generation, with our manifest | `COMMITTED` |
| Still `running` under our fence, no manifest | The commit is retried once |
| Anything else | `NOT_APPLIED` / `STALE_FENCE`: the attempt is abandoned, the lease expires, and the reclaim reuses the published file |

A unique violation goes through the same reconciliation and never surfaces
as a 500.

## 4. Retry classification (amendment A5)

| Failure | `lastErrorCode` | Retryable |
|---|---|---|
| Unsupported glyph | `document_generation_failed` | no |
| Snapshot not renderable; snapshot hash mismatch | `document_generation_failed` | no |
| Different bytes at the content address | `document_storage_failed` | no (integrity incident) |
| Renderer unavailable | `dependency_unavailable` | yes |
| Render engine failure | `document_generation_failed` | yes |
| Storage unavailable / misconfigured (errno-classified) | `document_storage_failed` | yes |
| Unclassified | `document_generation_failed` | yes |

Classification uses error types and errno codes only, never message text
(`attempt-failure.ts`). **Retryable:** the operation returns to `pending` with
the frozen backoff until the deadline. **Non-retryable (T12):** the operation
becomes `failed` at once with that code and `completed_at`, and
`quote.issue.failed` is recorded (`retryable: false`, `reason`).
`issuance_deadline_exceeded` is used only at the deadline. In both cases the
quote stays `issuing`; resolution is an operator retry (T10) after a fix, or
a creator cancel (T11).

## 5. Crash residue

| Crash point | Residue | Recovery |
|---|---|---|
| During render or temp write | maybe a temp file | lease expiry, reclaim (generation + 1), temp swept after 1 h |
| After publication, before T5 | a complete, verified, unreferenced file | the reclaim re-renders identical bytes (deterministic), gets `EEXIST`, verifies, reuses, and commits once |
| Zombie commit after a reclaim | its file (identical or orphan) | its T5 is `STALE_FENCE`: zero effect |
| T5 outcome unknown | complete file | reconciliation (§3) |

**Allowed:** temp files and complete, unreferenced files at their content
address. **Never possible:** a manifest naming missing bytes, or a partial
file at a final address. The rule is that an orphan file is acceptable and a
manifest without bytes is not.

## 6. Job activation and the one-attempt rule

`buildApplication` composes the jobs. The issuance runner is gated on full
readiness (database, schema, storage, renderer, lifecycle). The deadline
sweep is gated on persistence readiness only, so it keeps running while
storage or the renderer is down. `IssuanceWorker` owns a **single per-process
attempt slot**, shared by the periodic worker and every inline request; there
is no worker pool. PostgreSQL claims coordinate across processes. On shutdown,
`preClose` stops claims, aborts the in-flight attempt (never marked
succeeded) and stops the timers. The test seam
`BuildApplicationOverrides.disableIssuanceExecution` lets acceptance-only
suites observe `issuing`; production never sets it.

## 7. Inline issuance (Idempotency §4.4, A2)

For a **newly accepted** create-and-issue or draft issue, the route calls
`InlineIssuance.drive` after the acceptance commit:

- If the sync budget is 0 or dependencies are not ready, nothing runs inline
  and the answer is `202`.
- Otherwise the worker's slot is used: it claims and runs this operation
  (`claimOperation`, normal fencing).
- If the slot is busy, or another holder (worker or process) has the claim,
  the route only observes durable state.
- The route waits until the attempt ends, the operation is no longer
  active, or `QUOTE_ISSUANCE_SYNC_BUDGET_MS` runs out. An attempt still
  running when the budget ends continues under its lease.

The response is then **rebuilt from durable state**
(`readIssuanceResult`, one consistent snapshot): `201`/`200` only if the
quote is `issued` (manifest committed), otherwise `202` while the operation
continues. Replays never drive issuance: they answer the bound quote's
current state (`201`/`200` after issuance, with the same quote, number and
operation).

## 8. Verification

- Unit: store protocol (new, reuse, concurrent, conflict, interrupted temp,
  call order incl. fsync/link, traversal, temp sweep, probe), A5
  classification, attempt body, inline driver and the single slot. The store
  and renderer suites also ran inside `node:24.14.0-bookworm-slim` (Linux:
  directory fsync exercised).
- Integration (`issuance-commit.integration.test.ts`, real PostgreSQL):
  - T5 L–X;
  - zombie A/B;
  - crash windows Y/Z/AA/AB/AC/AE/AF;
  - A5 contract (unsupported glyph → T12, then T10 and T11; integrity
    conflict → T12, file untouched);
  - inline 0/short/large budget (202/202→issued/201/200);
  - replay;
  - inline/background race;
  - restart;
  - renderer-down readiness.
- Docker E2E (`npm run smoke:docker`, Linux image): 201 and 200 issuance with
  the PDF hash verified inside the container, stable across restart, then a
  budget-0 202 issued by the worker, and SIGTERM shutdown.

## 9. Deferred (B4)

`GET /v2/quotes/{id}/document` (reuses `readVerified`), the integrity
job/command over V2 manifests, and the full adversarial process-kill crash
matrix.
