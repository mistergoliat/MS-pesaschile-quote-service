# Quote Service V2 — State Machine

Status: **FROZEN (R1.2)**. Normative. Shapes: [openapi.yaml](openapi.yaml)
(`QuoteStatus`, `Operation`). Behavior context:
[QUOTE_V2_DOMAIN_CONTRACT.md](QUOTE_V2_DOMAIN_CONTRACT.md).

## 1. States

| State | Durable meaning | Snapshot | Number | Validity | Document | Formal quote? |
|---|---|---|---|---|---|---|
| `draft` | Editable caller snapshot; no issue commitment | mutable (version-fenced) | none | none | none | no |
| `issuing` | Issue accepted: snapshot frozen, number allocated, validity resolved, issuance operation durable | **immutable** | yes | yes | not available | **no** |
| `issued` | Document manifest committed | immutable | yes | yes | available, immutable | **yes** (while not expired) |
| `expired` | `now ≥ validity.validUntilExclusive` | immutable | yes | yes | available (historical) | no (historical) |
| `cancelled` | Cancelled by a principal, or by the system after issuance failure | immutable / last draft | yes if it was accepted for issue, else none | idem | available only if it had reached `issued` | no |

`accepted` and `paid` are not V2 states. Delivery states
(`pending, sending, sent, failed, unknown`) and operation states
(`pending, running, succeeded, failed`) are separate.

## 2. Diagram

```
                 POST /v2/quotes/drafts
                          │
                          ▼
   PATCH …/draft ──►   draft  ─────────── POST …/cancel ──────────────┐
   (version+1)  ◄──     │                                              │
                        │ POST …/issue  (acceptance tx)                │
   POST /v2/quotes ─────┤ (acceptance tx, no draft phase)              │
                        ▼                                              ▼
                     issuing ── issuance deadline exceeded (system) ─► cancelled
                        │                                              ▲
                        │ manifest commit (worker/handler, fenced)     │
                        ▼                                              │
                      issued ───────────── POST …/cancel ──────────────┘
                        │
                        │ now ≥ validUntilExclusive (projection; job materializes)
                        ▼
                      expired
```

## 3. Transition table

| # | From | To | Trigger | Initiator | Endpoint / job | Guard | Version | Timestamps / fields set | Audit event | Side effects | Reversible |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | — | `draft` | create draft | principal (`quotes:draft:write`) | `POST /v2/quotes/drafts` | valid body | 1 | `createdAt`, `updatedAt` | `quote.draft.created` | DB only | n/a |
| T2 | `draft` | `draft` | update draft | principal (`quotes:draft:write`) | `PATCH /v2/quotes/{id}/draft` | `expectedVersion` = version | +1 | `updatedAt` | `quote.draft.updated` | DB only | yes (edit again) |
| T3 | `draft` | `issuing` | issue | principal (`quotes:issue`) | `POST /v2/quotes/{id}/issue` | `expectedVersion` = version; ≥ 1 line; `expectedTotals` match; override authorized | +1 | `quoteNumber`, `issuance.issuedAt`, `validity`, `issuance.operationId` | `quote.issue.accepted` | DB only (number allocated) | no |
| T4 | — | `issuing` | create and issue | principal (`quotes:create`) | `POST /v2/quotes` | valid body; ≥ 1 line; `expectedTotals` match; override authorized | 1 | as T3 plus `createdAt` | `quote.issue.accepted` | DB only (number allocated) | no |
| T5 | `issuing` | `issued` | manifest commit | system (handler inline or issuance worker) | issuance operation | holder of current fencing generation; artifact written and hash-verified | +1 | `document.*`, operation `succeeded`, `completedAt` | `quote.issued` | file written before commit | no |
| T6 | `issuing` | `cancelled` | issuance deadline exceeded | system | issuance worker | `now ≥ operation.deadlineAt` and no manifest committed | +1 | `cancellation {reasonCode: issuance_failed, initiatedBy: system}`, operation `failed` | `quote.issue.failed`, `quote.cancelled` | none | no |
| T7 | `draft` | `cancelled` | cancel | principal (`quotes:cancel`) | `POST /v2/quotes/{id}/cancel` | `expectedVersion` = version | +1 | `cancellation` | `quote.cancelled` | none | no |
| T8 | `issued` | `cancelled` | cancel | principal (`quotes:cancel`) | `POST /v2/quotes/{id}/cancel` | `expectedVersion` = version; `now < validUntilExclusive` | +1 | `cancellation` | `quote.cancelled` | none; document unchanged; queued email deliveries not yet `sending` become `failed` (`quote_cancelled`) | no |
| T9 | `issued` | `expired` | validity elapsed | system | read projection + expiry job | `now ≥ validUntilExclusive` | +1 when materialized | `expiration.expiredAt = validUntilExclusive` | `quote.expired` (at materialization) | none; document unchanged | no |

Notes:

- **No public expire mutation.** T9 is never caller-triggered.
- **Expiry projection.** Every read returns `expired` for a stored `issued`
  quote with `now ≥ validUntilExclusive`, and `expiration.expiredAt` is
  exactly `validUntilExclusive` (migrated V1 quotes excepted, see
  [validity V-6](QUOTE_V2_VALIDITY_POLICY.md#1-definition)). Materialization by the job is
  idempotent and only changes `version`, `updatedAt` and the audit trail.
  Consumers therefore see a deterministic answer regardless of job lag.
- **Issuing past its validity.** If `validUntilExclusive` passes while the
  quote is `issuing` (only possible with a very short override), T5 still
  commits and the quote is immediately projected `expired`.
- **Cancel vs expiry race.** T8 is evaluated in the database transaction
  against the transaction clock; at or after the boundary it fails with
  `409 invalid_state_transition` (`details.status = "expired"`).

## 4. Rejected operations by state

| Operation \ state | `draft` | `issuing` | `issued` | `expired` | `cancelled` |
|---|---|---|---|---|---|
| `PATCH …/draft` | T2 | 409 `operation_in_progress` | 409 `invalid_state_transition` | 409 `invalid_state_transition` | 409 `invalid_state_transition` |
| `POST …/issue` | T3 | 409 `operation_in_progress` | 409 `invalid_state_transition` | 409 `invalid_state_transition` | 409 `invalid_state_transition` |
| `POST …/cancel` | T7 | 409 `operation_in_progress` | T8 | 409 `invalid_state_transition` | 409 `invalid_state_transition` |
| `GET …/document` | 409 `document_not_available` | 409 `document_not_available` | 200 | 200 | 200 if it reached `issued`, else 409 `document_not_available` |
| `POST …/deliveries/email` | 409 `invalid_state_transition` | 409 `invalid_state_transition` | 202 | 409 `invalid_state_transition` | 409 `invalid_state_transition` |

A replay of an already-bound request is answered from the binding before
these state checks (see [idempotency](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md));
e.g. replaying the cancel that produced `cancelled` returns `200`, while a new
cancel with another key returns `409 invalid_state_transition`.

## 5. Terminality and reversibility

`expired` and `cancelled` are terminal. No transition leaves them, nothing is
revived, and there are no revisions in V2: a commercial change after
acceptance is a **new quote** (new key, new number). `issuing → issued` is
the only automatic forward transition; `issuing → cancelled` happens only at
the issuance deadline.

## 6. Issuance operation states

| Operation status | Meaning | Quote status |
|---|---|---|
| `pending` | Accepted, waiting for (re)attempt at `attempts.nextAttemptAt` | `issuing` |
| `running` | A holder has the lease and is rendering/committing | `issuing` |
| `succeeded` | Manifest committed (T5) | `issued` (or later) |
| `failed` | Deadline exceeded (T6); terminal | `cancelled` (`issuance_failed`) |

`deadlineAt = acceptedAt + issuanceDeadline` (configuration, default 24 h,
range 1 h–72 h; frozen on the operation at acceptance). Every attempt failure
(`document_generation_failed`, `document_storage_failed`,
`dependency_unavailable`) is retried with backoff until the deadline, so a
renderer or storage fix deployed within the deadline completes the same quote.
Lease and fencing rules: [QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md §4](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md#4-issuance-operation-lease-fencing-and-recovery).
