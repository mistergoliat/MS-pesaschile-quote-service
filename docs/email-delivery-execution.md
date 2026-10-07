# V2 Email Delivery — Execution (R1.6B)

Status: R1.6B implementation note. Authority, in order:

1. the frozen contract in [`docs/v2/`](v2/README.md): Domain §10–§12, state
   machine §7 (rows D1–D7), Idempotency §5, and amendment **A6** (freeze
   record §3d);
2. the [R1.6 pre-flight audit](R1.6_PRE_FLIGHT_OPERATION_DELIVERY_AUDIT.md)
   and owner decisions W1–W10 (§34);
3. [R1.6A](email-delivery-request.md), the request and read core.

R1.6B turns a durable `pending` delivery into **one controlled external
email side effect**. No schema change: the head stays
`000009_quote_snapshot_child_insert_guard`. No contract change.

## 1. The guarantee

| Layer | Guarantee |
|---|---|
| Command | Exactly one delivery row per `(principal, quote.delivery.email, key)` (R1.6A). |
| Side effect | **At most one automatic, possibly-accepted provider call per delivery.** If an attempt may have been accepted, the service never sends that delivery again automatically. |

This is not exactly-once, and not at-least-once. `unknown` means **0 or 1
emails may have been accepted**. The service keeps that ambiguity instead of
risking a duplicate. A caller who wants another attempt must use a new
`Idempotency-Key`, which deliberately creates a new delivery.

## 2. State machine (frozen states only)

```
pending ──claim (quote lock, A6.1 re-check)──► sending ──accepted──────────────► sent      (terminal)
   │                                              ├─ provably not accepted, retry permitted ─► pending
   │                                              ├─ provably not accepted, permanent/exhausted ─► failed (terminal)
   │                                              ├─ may have been accepted (A6.3) ─► unknown (terminal)
   │                                              └─ lease expired (sweep) ─► unknown (terminal)
   └─ quote expired / cancelled at claim (A6.1) ─► failed (quote_expired / quote_cancelled), provider never called
```

| # | Transition | Where | Audit (principal `system`) |
|---|---|---|---|
| D1 | `pending → sending` | claim | — |
| D2 | `pending → failed` (`quote_expired` / `quote_cancelled` / `quote_not_issued`) | claim | `quote.delivery.failed` |
| D3 | `pending → failed` (`quote_cancelled`) | T8 cancel (R1.6A) | `quote.delivery.failed` (canceller) |
| D4 | `sending → sent` | fenced completion | `quote.delivery.sent` |
| D5 | `sending → pending` | fenced completion | none (no frozen attempt event); log `delivery.attempt_failed` |
| D6 | `sending → failed` | fenced completion | `quote.delivery.failed` |
| D7 | `sending → unknown` | fenced completion (ambiguous) or sweep (lease expired) | `quote.delivery.unknown` |

Audit `data` is `{deliveryId, documentSha256, attemptCount, errorCode?}`.
It never holds the recipient, a name, the subject, the body, provider text or
the provider message id. A delivery transition never writes the quote: its
state, version, snapshot and document stay the same.

## 3. Claim and lock order

Repository-wide lock order: **quote row, then delivery row.** T8 cancel locks
the quote and then fails `pending` deliveries. `appendAudit` also locks the
quote row. Every delivery transaction therefore takes the quote lock first:

1. Pick the oldest due `pending` delivery (`next_attempt_at <= DB now`) whose
   **quote** row can be locked now: `FOR UPDATE OF q SKIP LOCKED`. A quote
   held by a cancel, a request or another worker is skipped, never waited
   on.
2. Lock the delivery row. Re-check that it is still `pending` and due.
3. Evaluate the quote's **effective** status at that instant (A6.1), using
   the expiry projection with the database clock:
   - `issued`: the claim proceeds.
   - `expired`: `failed quote_expired`.
   - `cancelled`: `failed quote_cancelled`.
   - Anything else: `failed quote_not_issued` (fail closed; a queued delivery
     of a non-issued quote is impossible).
4. The claim sets `status = sending`, `generation + 1`,
   `lease_owner = <process-unique id>`, `lease_expires_at = now + lease`,
   `attempt_count + 1`, `last_attempt_at = now`, `next_attempt_at = null`.

The lease owner comes from the issuance pattern,
`<service>:<pid>:<random uuid>`. It is unique per process start. One attempt
runs at a time per process (a single slot). PostgreSQL coordinates between
processes.

Cancellation races (proven 12× on real PostgreSQL, with no deadlock):

- **Cancel wins:** T8 fails the `pending` row in its own transaction. The
  worker never sees it again.
- **Claim wins:** T8 leaves `sending` alone (frozen rule). The attempt
  finishes under its own lifecycle (`sent` / `failed` / `unknown`) and the
  quote stays `cancelled`.

Eligibility is checked only **before** the provider call. An attempt that
has started is never aborted, retried or resent because the quote expires or
is cancelled meanwhile.

## 4. Lease semantics: no renewal, never reclaimed

- The default lease is `QUOTE_EMAIL_DELIVERY_LEASE_MS` = 120 s, and it is
  **not renewed**. Configuration validation requires it to exceed the token
  timeout + the send timeout + a 10 s completion margin. The defaults
  (10 s + 30 s + 10 s) leave a wide margin.
- Before calling the provider, the worker checks that the remaining lease
  still covers the whole provider budget plus the margin. If it does not, the
  worker does not start the call and records `delivery_interrupted`
  (retryable, provably not sent).
- **Delivery differs from issuance on purpose.** An issuance lease that
  expires is reclaimed and re-rendered. A delivery lease that expires becomes
  **`unknown`**. No code path goes `sending → sending` under another holder,
  `sending (expired) → pending`, or `sending (expired) → provider`. The claim
  selects `pending` rows only.

### Expired-`sending` sweep

The sweep is persistence-only and always composed, even with the provider
disabled or broken and storage down. Each row is handled in its own
transaction under the quote → delivery locks and re-checked after locking:
`unknown`, `generation + 1` (which fences the late holder), lease cleared,
`last_error_code = delivery_outcome_unknown`, one `quote.delivery.unknown`,
and the log `delivery.outcome_unknown` with `reason: lease_expired`. It is
idempotent: two sweepers produce one transition and one event.

### Known false-`unknown` window (accepted)

If a process dies **after the claim and before the provider call**, the row
stays `sending` until its lease expires and then becomes `unknown`, even
though no email was sent. This is deliberate. Duplicate avoidance comes
first, and nothing resends to remove the false `unknown`.

## 5. Mail port and outcome model

`MailSenderPort.send(mail) → MailSendOutcome`:

| Outcome | Meaning | Delivery |
|---|---|---|
| `accepted {providerMessageId \| null}` | any send-phase 2xx | `sent` |
| `not_accepted {retryable, code}` | **provably** not accepted | `pending` (retry) or `failed` |
| `ambiguous {code}` | it may have been accepted | `unknown` |

Expected provider and network outcomes are returned, never thrown. A throw
from the adapter is a programming error, and the worker records it as
**ambiguous** (`email_outcome_unknown`).

Persisted codes are generic. No Gmail name is stored.

| Code | Origin | Retry |
|---|---|---|
| `email_provider_unavailable` | token phase failure, or a connect failure proven before transmission | yes |
| `email_authentication_failed` | `invalid_grant`, `invalid_client`, 401/403 (token or send phase) | yes (W5) |
| `email_rate_limited` | 429, or 403 with a rate-limit reason | yes |
| `email_provider_rejected` | send 400/404/405/413/414/415/422 | no |
| `email_message_invalid` | the adapter refused to build the message (recipient/header) | no |
| `email_outcome_unknown` | ambiguous send outcome | terminal `unknown` |
| `document_storage_failed` | committed PDF missing, unreadable, corrupt or not the pinned one | yes |
| `delivery_preparation_failed` | delivery data or envelope could not be prepared | yes |
| `delivery_interrupted` | stopped before the provider call (shutdown, lease budget) | yes |
| `delivery_outcome_unknown` | lease expired while sending (sweep) | terminal `unknown` |
| `quote_expired` / `quote_cancelled` / `quote_not_issued` | A6.1 at claim | no |

## 6. Gmail adapter

`src/infrastructure/email/gmail-mail-sender.ts` makes one OAuth refresh-token
grant and one `users.messages.send` per attempt. The adapter never retries.
**The central question: can we prove the provider did not accept the
message?**

**Token phase.** No send request exists yet, so nothing was sent. Every
failure is `not_accepted` and retryable: `invalid_grant`, 401/403, 429, 5xx,
a timeout, a network error or a missing token. Under W5 this lets a
credential repair take effect on the same delivery. At exhaustion the
delivery is `failed` with the last real code. Send is never called after a
token failure.

**Send phase.**

| Result | Outcome |
|---|---|
| 2xx with an id | accepted (id) |
| 2xx without an id, or with an unreadable body | **accepted, `providerMessageId = null`** (never failed) |
| 429; 403 with `rateLimitExceeded` / `userRateLimitExceeded` / `dailyLimitExceeded` / `quotaExceeded` | not accepted, retryable |
| 401; other 403 (rejected before acceptance) | not accepted, retryable (W5) |
| 400, 404, 405, 413, 414, 415, 422 | not accepted, permanent |
| **any 5xx (A6.3)**, 408, 3xx, any other status | **ambiguous** |
| our send timeout (`AbortSignal.timeout`) | ambiguous |
| reset or close after dispatch (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`) | ambiguous |
| connect failure **proven by errno/undici code** (`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, TLS certificate validation codes) | not accepted, retryable |
| anything else (no typed code, message text only, mixed codes) | **ambiguous** |

Error messages are never parsed. Only typed `code` values on the cause chain
are used, and a timeout or abort is never treated as proof. Even if Google
documents retrying a 5xx, the frozen contract (A6.3) chooses duplicate
avoidance over delivery completeness.

**Timeouts.** Separate `AbortSignal` timeouts, each covering the request and
its response body: `QUOTE_EMAIL_TOKEN_TIMEOUT_MS` (default 10 s) and
`QUOTE_EMAIL_SEND_TIMEOUT_MS` (default 30 s). No fetch is unbounded. The
committed-PDF read is bounded to 10 s, and the completion transaction is
bounded by the database statement timeout.

**Privacy.** Outcomes carry codes only. The provider body, tokens, the
`Authorization` header and every address stay inside the adapter, which does
not log.

**Where recipient data lives.** The request (R1.6A) intentionally persists
the recipient snapshot in the private columns `quote_deliveries.recipient_email`
and `recipient_name`. The worker needs them to send, and they are never
re-resolved. They never appear in:

- public responses, which carry only `recipientMasked`;
- audit payloads;
- runtime logs;
- persisted error data, which holds `last_error_code` only (there is no
  provider text column).

The redaction test in `delivery-execution.integration.test.ts` asserts both
sides: the private columns hold the snapshot, and none of these outputs
contains it.

## 7. MIME, RFC 2047 and Message-ID

`src/infrastructure/email/mime-message.ts`:

- **Recipient defense in depth.** The adapter re-validates `to` on its own
  (`strict-mailbox.ts`): exactly one bare ASCII `dot-atom@LDH-domain`, local
  part ≤ 64, total ≤ 254. It rejects `<>`, `,`, `;`, `:`, quotes, comments,
  whitespace, CR/LF, address literals and display-name syntax. The V1
  `normalizeEmailAddress` is gone. `To:` holds only the mailbox. The
  recipient's name is used only in the escaped HTML greeting.
- **Headers.** From (optional display name), To, Reply-To (when configured),
  Subject, Message-ID, Date and MIME-Version. CR/LF and control characters
  are rejected in every input. A non-ASCII Subject or display name is
  encoded as RFC 2047 `=?UTF-8?B?…?=` words of at most 75 characters, split
  on code-point boundaries and folded. An ASCII display name is a quoted
  string. Tests cover "Cotización", "Peñalolén" and "Ñandú".
- **Message-ID.** Deterministic: `<delivery.{deliveryId}@{sender-domain}>`.
  The domain comes from the validated `QUOTE_EMAIL_FROM_ADDRESS`. The ID is
  the same on every attempt of a delivery, carries no recipient data and has
  no random part. It is an operational aid only. Nothing claims that Gmail
  deduplicates on it. W10 (a live check that Gmail preserves it) remains
  optional and outside R1.6B.
- **Structure.** `multipart/mixed` contains `multipart/related` (HTML plus
  the code-owned logo CID) and one `application/pdf` attachment. All bodies
  are base64 with 76-column lines. Boundaries are code-generated. File names
  and content IDs must match conservative code-owned patterns. No dynamic
  value can become a header name, a boundary, a path or a raw header.

## 8. V2 email envelope (no commercial authority)

`application/quote-v2/delivery/email-envelope.ts` holds the model, and
`infrastructure/email/quote-email-envelope-template.ts` renders the HTML.
The version is `quote-email-envelope-v3`.

```
Subject: Cotización Pesas Chile <quoteNumber>

Hola {escaped recipient name | ""},
Adjuntamos la cotización <quoteNumber> emitida el <DD/MM/AAAA>.
La cotización formal se encuentra en el archivo PDF adjunto.
Para consultas, responde a este correo.
Pesas Chile
```

- **Inputs:** the quote number, `validity.issueLocalDate` (the Chile civil
  date, transformed as a string and never converted through UTC) and the
  delivery's recipient-name snapshot. Nothing else is looked up.
- **Absent on purpose:** lines, quantities, prices, net/tax/gross totals,
  shipping, "Precios incluyen IVA" and any tax statement (U2), the validity
  policy (the old "5 días"), the issuer's legal name, RUT and address (U3),
  and any personal employee signature. The PDF is the only formal commercial
  artifact. A test asserts the exact visible text.
- **Escaping and links:** every interpolation goes through `escapeHtml`, and
  there are no dynamic links.
- **Copy approval:** the copy is **provisional** and needs owner approval at
  R1.7 (W8). `npm run email:preview` renders it offline.

## 9. Verified attachment

For every attempt, before any provider contact:

1. Load, in one read-only snapshot, the delivery's recipient snapshot, the
   frozen quote facts and **the quote's committed manifest**.
2. Require `manifest.quoteId == delivery.quoteId` and
   `manifest.pdfSha256 == delivery.documentSha256`. No other manifest is ever
   substituted.
3. `ContentAddressedArtifactStore.readVerified(manifest)` reads the file once
   and verifies its length and hash.
4. Check `sha256(bytes) == delivery.documentSha256` again.
5. Attach exactly those bytes, named `<quoteNumber>.pdf`.

Nothing is re-rendered, repaired or read from a path. A failure in steps 1–4
is **known not sent**. It records `document_storage_failed` (retryable within
the policy, then `failed` with the same code) and emits the existing operator
log `document.integrity_failed` (`MISSING`, `HASH_MISMATCH`,
`MANIFEST_MISMATCH`, `READ_TIMEOUT`, …).

## 10. Retry policy (W9, code-owned)

| | |
|---|---|
| Maximum attempts | **6** (the sixth is the last) |
| Delays after a safe failure of attempt 1–5 | **1 m, 5 m, 15 m, 1 h, 4 h** |
| Window | no retry scheduled after `requested_at + 24 h` |
| Exhaustion | `failed` with the **last real code** (no generic "exhausted" code) |
| Durability | `next_attempt_at` and `attempt_count` are stored in the database; database timestamps only; no in-memory timer is authoritative |

Issuance backoff is not reused. `unknown`, `failed` and `sent` have
`next_attempt_at = null`. T8 now clears it on the deliveries it fails too.

## 11. Completions

All completions are fenced on `delivery_id`, `generation`, `lease_owner` and
`status = sending`, under quote → delivery locks.

- **Accepted:** `sent`, `sent_at = DB now`, nullable `provider_message_id`
  (internal only; never in the public `Delivery`), lease cleared, audit
  `sent`, log `delivery.sent` (with `providerMessageId` and
  `templateVersion`).
- **Retryable:** `pending`, `next_attempt_at`, `last_error_code`, lease
  cleared, log `delivery.attempt_failed` (`attemptCount`, `errorCode`,
  `nextAttemptAt`).
- **Permanent or exhausted:** `failed`, `last_error_code`, audit `failed`,
  log `delivery.failed`.
- **Ambiguous:** `unknown`, audit `unknown`, log `delivery.outcome_unknown`.
- **Lease expired but not yet swept:** still the holder's. The outcome it
  reports is the truth, and it wins if it commits first.
- **Stale or late result:** zero rows. The delivery is not changed. Log
  `delivery.late_result` (with the provider id when the late result was an
  acceptance). Nothing is ever sent to compensate.
- **COMMIT outcome unknown:** the worker re-reads the row.
  - Our intended terminal state at our generation: the completion landed.
  - Still `sending` under our fence: `delivery.completion_unknown`. The
    completion is **not** replayed and the provider is **not** called again;
    the lease expires and the sweep records `unknown`.
  - Anything else: stale.

## 12. Composition, shutdown and health

| `QUOTE_EMAIL_PROVIDER` | Sender | Send runner | Sweep | New requests |
|---|---|---|---|---|
| `disabled` (default) | none | none | yes | `503 email_provider` (A6.2 order, R1.6A) |
| `gmail` (all `GOOGLE_GMAIL_*` and `QUOTE_EMAIL_FROM_*` valid) | `GmailMailSender` | yes | yes | `202`, even while the provider is unhealthy |

- There is no `fake` value. Test senders exist only through
  `BuildApplicationOverrides.testMailSender`. `disableDeliveryExecution` and
  `deliveryFailpoints` are test seams with the same rules as the issuance
  seams (constructor-only, never in `src/server.ts`). Provider endpoints can
  be overridden only through the adapter constructor, never through
  configuration.
- **Send runner** (`emailDelivery`): gated on persistence + artifact
  storage (`isDocumentReadReady`). A renderer outage does not pause email.
  Each tick claims at most 5 deliveries, one at a time.
- **Sweep** (`deliveryOutcomeSweep`): gated on persistence only. Each tick
  also refreshes the queue metrics.
- **Shutdown:** the worker stops claiming and does not start a new provider
  call. A claimed-but-not-started attempt records `delivery_interrupted`
  (retryable; nothing was sent). An in-flight call finishes under its own
  timeouts and is never put back to `pending`. If the process is killed, the
  lease expiry makes the row `unknown`.
- **`/health/ready` is unchanged.** Email is never part of readiness,
  business-route gating, quote reads or `GET /document`. The renderer
  over-gating was removed in R1.6D (capability gates).
- **`emailProvider`** (frozen `DependencyStatus`) is never probed by sending
  anything. It comes from configuration and the latest worker outcome:
  `disabled`; `up` (configured, or after an acceptance, which also sets
  `lastSuccessAt`; a permanent rejection also counts as up); `down` /
  `authentication`; `down` / `unreachable`; `degraded` / `provider_error`
  (rate limited or ambiguous). It is in-memory and resets on restart.
- **`workers.emailDelivery`:** `enabled` means the send runner exists.
  `queueDepth` counts the **due** `pending` rows (`next_attempt_at <= now`).
  `oldestPendingAgeSeconds` is the number of seconds since the oldest due
  row became due, measured on the database clock, or null when none is due.
  Both are measured by the sweep. Future-scheduled retries and
  `sending`/`sent`/`failed`/`unknown` rows are excluded. Issuance and expiry
  use the same "due now" definition since R1.6D.

## 13. No automatic email; no reconciliation

- Issuance (acceptance, the inline attempt, the worker, T5) never imports a
  mail sender, never creates a delivery and never sends. This is enforced by
  the closure test in `test-seams.test.ts` and by zero-delivery assertions in
  the issuance suites. Only explicit delivery rows drive the worker.
- `unknown` is terminal. There is no automatic provider lookup and no
  operator transition. Reconciling `unknown` deliveries is FUTURE work (it
  needs Gmail read scope and an amendment). An operator can search the
  sending mailbox by the deterministic `Message-ID`.

## 14. V1 retirement (done in R1.6B)

Deleted, after the import graph showed that only V1 email code, scripts and
their own tests used them:

- `src/domain/*`
- `application/quote-delivery/*` (V1 port, retry policy, subject)
- `CanonicalIssuedQuoteSnapshot`
- `formatCommercialUnitPriceDisplay` and the UTC email date formatter
- the V1 email view model, template and `document-templates` shim
- the V1 inline-asset resolver
- `pesaschile-brand-v1.ts` / `brand-theme.ts` (personal signature,
  hard-coded 5-day policy, legal-name input)
- the V1 Gmail sender
- the live `email:smoke:pdf` script and the legacy email fixture
- `QUOTE_COMPANY_NAME`

Kept: the immutable migrations, the content-addressed and legacy document
storage primitives, the brand asset registry and resolver (logo),
`html-escaping.ts`, and `display-formatting.ts` (used by the PDF).
`clock-port.ts` / `system-clock.ts` were unrelated leftovers, removed in the
R1.6D cleanup.

## 15. Evidence

| Suite | Covers |
|---|---|
| `test/unit/gmail-mail-sender.test.ts` | A–O: token and send classification, 2xx without id, 429/4xx/5xx, timeouts, resets, errno-proven connect failures, unclassifiable failures, real loopback sockets (refused, reset after receipt, hang), no secret or body in outcomes |
| `test/unit/email-mime-envelope.test.ts` | P–AB: one `To`, hostile recipients, RFC 2047 round trip and 75-character words, CR/LF, deterministic Message-ID, exact PDF bytes and file name, envelope content (exact visible text, no commercial or tax content), escaping; W9 schedule and window |
| `test/integration/delivery-execution.integration.test.ts` (real PostgreSQL) | AC–AS worker states and audit; AT–BA verified attachment (missing, corrupt, other manifest, real issuance byte equality, no re-render); BB–BI retries and restart durability; BN/BO cancel races ×12; BP–BR sweep races ×10; BS–BV request regression; BX–CC health; CD–CH queue metrics; §76 redaction with the real adapter against a hostile loopback provider |
| `test/integration/delivery-process-crash.integration.test.ts` (SIGKILL) | BJ claim then crash → real lease expiry → `unknown`, 0 provider calls; BK accepted then crash → `unknown`, exactly 1 call; BL crash after the `sent` COMMIT → `sent`, 1 call; BM sweep wins → `delivery.late_result`, `unknown`, 1 call; stop before claim → the next process sends exactly once |
| `test/unit/test-seams.test.ts` | seams are constructor-only; no configuration selects a fake or an endpoint; only the delivery worker calls a sender; issuance/document closure reaches no sender or delivery code; no V1 email model, signature, "5 días" or IVA text in `src` |
| `scripts/docker-smoke.mjs` `v2Delivery` | production image: provider disabled, `503` with nothing bound, `emailProvider: disabled`, no send runner, empty queue, readiness `200`, no delivery log activity |

## 16. R1.6 status and remaining work

| Slice | Status |
|---|---|
| R1.6A delivery request core | **CLOSED** |
| R1.6B delivery execution | **CLOSED** |
| R1.6C operator controls | **CLOSED** ([operator-controls.md](operator-controls.md)) |
| R1.6D readiness, jobs, hardening | **CLOSED** ([operational-hardening.md](operational-hardening.md)) |
| R1.7 production readiness | NEXT |

**R1.6C**

- `issuance:retry` CLI (T10, operator plane only)
- `issuance:failed` CLI (read-only listing)
- `documents:repair` CLI (hash-reproducing re-render only)

**R1.6D**

- capability-specific readiness (route and job gating; `/health/ready`
  unchanged)
- expiry materialization (T9, `quote.expired`)
- periodic document integrity job
- issuance and expiry worker metrics
- V1 retirement: `/v1/*` → `410 api_version_retired`
- operational hardening (the `clock-port` / `system-clock` leftovers, a
  migration rehearsal report)

**R1.7**

- U2 / U3 approval
- email copy approval (W8)
- production credentials (Gmail OAuth and sender alias, principals, DB
  roles)
- deployment and V1 cutover

**W10 (optional, separately authorized):** a live non-production check of
`Message-ID` preservation.
