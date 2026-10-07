# Runbook: issuance retry and document repair (R1.6C)

Design and guarantees: [docs/operator-controls.md](../operator-controls.md).

All identifiers below are fake. Run the commands on the service host (or in
the service image) with the service's runtime configuration: `DATABASE_URL`
(runtime role), the principal registry and `QUOTE_DOCUMENT_STORAGE_ROOT`.
Use the `:runtime` variants with a build or the image; the variants without
`:runtime` run from source.

Always: **detect → inspect → dry run → `--yes` → verify.** Keep each
command's JSON output with the incident record: for repair it is the only
record (there is no repair audit event).

Never edit `quote_documents`, `issuance_operations` or audit rows by hand.
Never delete or overwrite a file under `artifacts/sha256`.

## Exit codes

`0` done · `1` could not run (retry later, investigate) · `2` refused
(something is wrong: read `reason`) · `3` not applicable (state does not
allow it; usually already handled).

## A. A quote is stuck `issuing` with a failed issuance operation

**1. Detect.** Operator alert (`issuance.deadline_failed` or
`issuance.failed_non_retryable` log events), or:

```
npm run issuance:failed:runtime
npm run issuance:failed:runtime -- --error document_generation_failed --limit 20
```

Each item has `quoteId`, `operationId`, `lastErrorCode` and `attemptCount`.

**2. Inspect and fix the cause first.** A retry re-runs the same issuance of
the same frozen snapshot with the same renderer:

| `lastErrorCode` | Typical cause | Before retrying |
|---|---|---|
| `issuance_deadline_exceeded` | renderer or storage was down until the deadline | confirm `/health/ready` is `200` and storage is writable |
| `document_generation_failed` | non-retryable render failure (e.g. a character the pinned font cannot draw) | a retry with the same build fails again; the creator may cancel (T11) instead |
| `document_storage_failed` | integrity incident: different bytes already at the content address | treat as an integrity incident (section B.4) before retrying |

**3. Dry run** (writes nothing):

```
npm run issuance:retry:runtime -- \
  --quote 00000000-0000-4000-8000-000000000001 \
  --operation 00000000-0000-4000-8000-0000000000a1 \
  --operator ops-example-operator \
  --reason renderer_fixed
```

Expect `"status": "dry_run"`. Check `quoteNumber`, `failedOperationId` and
`lastErrorCode`. `--operator` must be your own registered principal of type
`operator`; service principals, `system` and `legacy-v1` are refused.
`--reason` is a code such as `renderer_fixed`, `storage_restored`,
`configuration_restored` or `operator_recovery`. Never put names, emails or
ticket text in it (free text is refused).

**4. Execute.** Same command plus `--yes`. Expect `"status": "retry_created"`
and a `newOperationId`.

- Exit `3` / `INVALID_STATE`: someone already retried or the creator
  cancelled. Re-run step 1; do not retry blindly.
- Exit `1` / `not_applied`: the commit could not be confirmed and nothing was
  applied. Re-run step 1, then step 3.
- Exit `2` / `SNAPSHOT_INTEGRITY`: the stored snapshot no longer matches what
  was accepted. Do not retry. Escalate as a data-integrity incident.

**5. Verify.** `issuance:failed` no longer lists the quote while the retry is
pending. Within the poll interval the worker issues it: `GET
/v2/quotes/{quoteId}` shows `issued` with the same `quoteNumber`, and the
audit shows `quote.issue.accepted` by your principal with `retryOf` and
`reasonCode`.

## B. A formal PDF is missing (document endpoint answers `503 document_storage_failed`)

**1. Detect.** `document.integrity_failed` log, or:

```
npm run documents:verify:runtime
```

Note the `quoteId`, `documentId` and status (`MISSING`, `HASH_MISMATCH`,
`LENGTH_MISMATCH`, `READ_FAILED`).

**2. Prefer the backup.** Restoring the storage volume from backup is the
first option. Repair is for when that is not possible.

**3. Dry run** (renders in memory, publishes nothing):

```
npm run documents:repair:runtime -- \
  --quote 00000000-0000-4000-8000-000000000002 \
  --document 00000000-0000-4000-8000-0000000000d2 \
  --operator ops-example-operator
```

| Result | Meaning | Next |
|---|---|---|
| `dry_run` / `would_repair` (exit 0) | the running build reproduces the exact recorded bytes | step 5 |
| `dry_run` / `would_conflict` (exit 2) | reproducible, but a different file occupies the address | step 4 |
| `already_intact` (exit 0) | nothing to do | verify (step 6) |
| `NOT_REPAIRABLE_LEGACY` (exit 2) | migrated V1 document; its renderer is retired | restore from backup only |
| `RENDERER_VERSION_MISMATCH` / `TEMPLATE_VERSION_MISMATCH` (exit 2) | the running build is not the build that produced the document | run the matching build, or restore from backup. Never "close enough" |
| `SNAPSHOT_HASH_MISMATCH` / `MANIFEST_INCONSISTENT` / `STORAGE_KEY_INVALID` (exit 2) | stored data does not match the record | data-integrity incident; escalate |
| `HASH_MISMATCH` (exit 2) | the re-render is not byte-identical | restore from backup; escalate |

**4. Quarantine a conflicting file** (only after `would_conflict`). The
command never removes files. As the storage owner, move the file out of the
storage root into an incident area, keeping it as evidence (do not delete
it). Its location is
`<storage root>/artifacts/sha256/<first 2 hex>/<next 2 hex>/<pdfSha256>.pdf`
for the manifest's `pdfSha256`. Then re-run the dry run: it must report
`would_repair`.

**5. Execute.** Same command plus `--yes`. Expect `"status": "repaired"` (or
`already_restored` if identical bytes appeared meanwhile). `INTEGRITY_CONFLICT`
means a different file is at the address again: go back to step 4.

**6. Verify.**

```
npm run documents:verify:runtime
```

The document must no longer be listed, and `GET
/v2/quotes/{quoteId}/document` answers `200` with `X-Document-Sha256` equal
to the manifest's `pdfSha256`. Nothing else changes: the quote, its
operations, its audit and its manifest stay exactly as they were.
