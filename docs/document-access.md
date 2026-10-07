# Quote Service — Document Access and Integrity (R1.5B4)

Status: **implemented.** This slice serves formally issued PDFs and detects
when stored bytes are lost or altered. It builds on
[issuance execution (B3)](issuance-execution.md). Normative behaviour:
[Domain §9.3/§9.4](v2/QUOTE_V2_DOMAIN_CONTRACT.md#9-document),
[state machine §4](v2/QUOTE_V2_STATE_MACHINE.md#4-rejected-operations-by-state),
[security §3](v2/QUOTE_V2_SECURITY_SCOPES.md) and openapi `getQuoteDocument`.
No contract amendment and no migration were needed (the schema head is still
`000009_quote_snapshot_child_insert_guard`). The crash and failure evidence is
in [issuance-crash-matrix.md](issuance-crash-matrix.md).

## 1. `GET /v2/quotes/{quoteId}/document`

| Step | Behaviour |
|---|---|
| 400 → 401 → 403 | `quoteId` must be a UUID. Bearer principal. Scope `quotes:document:read` |
| visibility | The same SQL rule as `GET /v2/quotes/{id}`: the creator, or `quotes:read:any`. Anything else is `404 quote_not_found`, byte-for-byte the same as a missing quote |
| availability | Served only if a committed manifest exists, meaning the quote reached `issued`. That covers `issued`, `expired` (projected or materialized) and cancelled after issue. `draft`, `issuing`, cancelled-before-issue and a T12-failed issuance give `409 document_not_available` with `details.status` (the effective status) |
| read | `readVerified(manifest)` with the **committed DB manifest** as input, never caller input (§2) |
| integrity failure | `503 document_storage_failed` with `Retry-After: 5` and a sanitized JSON body. The operator signal `document.integrity_failed` is logged at error level with `quoteId`, `documentId`, `origin`, `integrityStatus` and `fsCode`. No path or key is logged. Nothing else happens |
| 200 | The verified buffer itself (§2) |

**Never:** render, re-render, repair, overwrite, delete, change the manifest
or the quote, create an operation or an audit event, or call Catalog,
Shipping, Customer Profile or CRM. A read is a read-only DB snapshot plus one
file descriptor. There are no capability URLs and no V1 HMAC references.

**Headers (200):**

| Header | Value | Source |
|---|---|---|
| `Content-Type` | `application/pdf` | contract |
| `Content-Length` | byte length of the verified buffer | HTTP |
| `Content-Disposition` | `attachment; filename="<quoteNumber>.pdf"` | contract |
| `X-Document-Sha256` | `pdfSha256` | contract |
| `ETag` | `"<pdfSha256>"` (strong) | contract |
| `Cache-Control` | `private, no-store` | HTTP metadata, not API schema: the document is personal data (security §6) |
| `X-Content-Type-Options` | `nosniff` | HTTP metadata |

The file name comes from `quoteNumber` only. A value outside
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (which never happens for `PC-NNNNNN`) falls
back to `quote.pdf`. It is never derived from a storage key or a path. No
header or body ever contains the storage root, a temp path, the storage key
or a stack trace.

**Readiness.** The route sits in the same readiness-gated business context as
every V2 route. During a renderer or storage outage it answers
`503 dependency_unavailable` (B3 gate, unchanged), even though serving needs
only the database and storage.

## 2. Verified read (no verify-then-reopen window)

`FilesystemContentAddressedArtifactStore.readVerified(manifest)` takes
`{origin, storageKey, pdfSha256, byteLength}`:

1. Key check. A V2 (`issuance`) key must equal
   `artifacts/sha256/<aa>/<bb>/<pdfSha256>.pdf`. Any key must be root-confined
   with no `..`. A failure here is `KEY_INVALID`.
2. One `open(O_RDONLY | O_NOFOLLOW)` (POSIX; Windows has no `O_NOFOLLOW`). A
   symlink planted at the address is `READ_FAILED`.
3. `fstat` on the descriptor. The size must equal the manifest `byteLength`
   (`LENGTH_MISMATCH`) and stay within `MAX_COMMITTED_DOCUMENT_BYTES` =
   16 MiB (`OVERSIZED`, refused **before** allocating). A 100-line quote is
   about 63 KB, so the bound is about 250× the largest legitimate PDF.
4. Read exactly that many bytes from the same descriptor, then confirm EOF
   (`LENGTH_MISMATCH` if the file shrank or grew).
5. SHA-256 of the buffer must equal `pdfSha256` (`HASH_MISMATCH`).

The route sends **that buffer**: the bytes served are the bytes hashed. With
content-addressed files that are write-once and never deleted, no window
remains between the verify and the stream. PDFs are bounded at tens of KB, so
buffering is deliberate. There is no streaming optimization.

Result categories: `OK`, `MISSING` (ENOENT/ENOTDIR), `HASH_MISMATCH`,
`LENGTH_MISMATCH`, `READ_FAILED`, `KEY_INVALID`, `OVERSIZED`.

## 3. Integrity verifier (operator command)

`npm run documents:verify` (`documents:verify:runtime` in the image) runs
`verifyDocumentArtifacts`. It walks every committed manifest (V2 and migrated
V1) in keyset batches of 200 and checks each one with the same `readVerified`.

- Output is JSON with `checked`, `ok`, `byStatus` and `problems[]`
  (`documentId`, `quoteId`, `origin`, `status`). There are no paths, keys or
  customer data.
- Exit codes: 0 when everything verifies, 2 on any problem, 1 when the check
  could not run.
- **Detection only:** no repair, no re-render, no deletion, and no V2
  manifest is ever written.
- `--record-byte-length` (R1.4, unchanged) records the verified size of a
  legacy V1 manifest whose `byte_length` is null, once. It is opt-in and
  legacy-only, and it is the only manifest change the immutability trigger
  permits.

**Activation.** There is an operator command and **no** periodic job. Roadmap
R1.6 owns the always-on "artifact integrity check job". Readiness never waits
for a scan of historical PDFs, and nothing scans the table on start.

**No auto-repair.** The B0 audit found deterministic re-rendering
technically possible under an identical renderer build (renderer, template,
assets, Node, pdfmake, pdfkit, zlib). B4 deliberately does not use it. Repair
is an explicit operator procedure (R1.6C `documents:repair`,
[operator-controls.md](operator-controls.md)) that publishes only bytes that
reproduce the recorded `pdfSha256` (Domain §9.3). Until an operator runs it,
the artifact stays unavailable (`503`) and the historical record stays intact. The test suite proves that only bytes with
the recorded hash are ever served again.

## 4. Legacy (migrated V1) documents

V1 → V2 migration (R1.4) kept the V1 storage key (not content addressed),
`templateVersion = v1-legacy` and `byte_length = null`. B4 serves them under
the same rules, with these differences:

- the key is not forced into the V2 layout (it is root-confined only);
- a null `byteLength` skips only the length equality, while the size bound
  and SHA-256 still apply, and serving records nothing;
- legacy quotes belong to `legacy-v1`, so only `quotes:read:any` principals
  see them;
- V1 HTML artifacts stay unserved (no public HTML in V2).

## 5. Seams and safety

- Production composition: `src/server.ts` → `buildApplication(env)` with no
  overrides.
- `disableIssuanceExecution` (B3) and `issuanceFailpoints` (B4) are
  `BuildApplicationOverrides` members only. No environment key maps to them
  (unknown keys are dropped by the env schema), only `config/env.ts` reads
  `process.env` in the runtime closure, and no route can reach them.
  `test/unit/test-seams.test.ts` enforces all of this.
- The document, verifier, issuance and job modules have an import closure
  that cannot reach the legacy mutable storage (`deleteStorageKey`,
  `deletePrefix`, `writeBuffer`) or any email module. In the
  content-addressed store, every `unlink` targets a temp or probe path under
  `artifacts/tmp`, also tested with a recording `unlink`.

## 6. Robustness fix found by the adversarial suite

`PostgresDatabase.withTransaction` and `withAdvisoryLock` now keep an
`error` listener on the checked-out client. pg-pool removes its own listener
on checkout, so a connection that died mid-transaction (database restart,
network drop, a connection cut during COMMIT) emitted an unhandled `error`
event. `server.ts` treats that as a programmer error and **exits the
process**. The wire-level COMMIT-cut test on a live process reproduced this
before the fix. After the fix, the pending query rejects normally, the
broken client is discarded and the process stays up.
