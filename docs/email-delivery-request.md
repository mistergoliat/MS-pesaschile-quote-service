# V2 Email Delivery — Request and Read Core (R1.6A)

Status: R1.6A implementation note. Authority, in order:

1. the frozen contract in [`docs/v2/`](v2/README.md): Domain §10, §11 and §12,
   state machine §3 (T8) and §4, Idempotency §2, §3 and §5, Security §2 and
   §3, and `openapi.yaml` (`requestEmailDelivery`, `getDelivery`, `Delivery`,
   `EmailDeliveryRequest`);
2. amendment A6, delivery eligibility, replay and ambiguity
   ([freeze record §3d](v2/QUOTE_V2_CONTRACT_FREEZE.md); this slice implements
   A6.2, see §8);
3. the [R1.6 pre-flight audit](R1.6_PRE_FLIGHT_OPERATION_DELIVERY_AUDIT.md).

**R1.6A sends no email.** It durably queues delivery requests and serves
their reads. There is no delivery worker. Nothing calls a mail port. No
Gmail code is reachable from `src/server.ts`. The production composition
configures no sender, so every new request answers `503 email_provider`.
Delivery execution (worker, V2 Gmail adapter, email envelope) is R1.6B.

## 1. Files

| File | Responsibility |
|---|---|
| `src/application/quote-v2/delivery/mail-sender-port.ts` | Generic V2 mail port and outcome model (accepted / not accepted / ambiguous). Only the composition root holds one, and nothing calls it in R1.6A |
| `src/application/quote-v2/delivery/delivery-request.ts` | Closed `EmailDeliveryRequest` schema, strict single-mailbox validation, recipient resolution and masking, `EmailProviderDisabledError` |
| `src/infrastructure/persistence/postgres/quote-v2-deliveries.ts` | The request transaction, the visible read, and the `Delivery` representation |
| `src/http/routes/v2-delivery-route.ts` | `POST …/deliveries/email`, `GET …/deliveries/{deliveryId}` |
| `src/infrastructure/persistence/postgres/quote-v2-cancel.ts` | T8 now also writes one `quote.delivery.failed` per delivery it fails |
| `src/app.ts` | `MailSenderPort | null` composition. Production: `null`. Test seam: `testMailSender` |

No migration. The V2 `quote_deliveries` table (`000007`) and the delivery
bindings already supported every invariant. The schema head stays `000009`.

## 2. Trigger

`POST /v2/quotes/{quoteId}/deliveries/email` is the only operation that can
create a delivery (Domain D-3, §10.1). Issuance (`POST /v2/quotes`, issue,
the worker, inline attempts) creates **zero** deliveries. Every crash test
and the delivery suite assert this.

## 3. Evaluation order

| Step | Check | Result |
|---|---|---|
| 1 | body size, JSON, headers (`Idempotency-Key`, `X-Correlation-Id`), path UUIDs | `413` / `400` |
| 2 | credential | `401 unauthenticated` |
| 3 | scope `quotes:delivery:email` | `403 forbidden` (`details.requiredScope`) |
| 4 | idempotency binding `(principal, quote.delivery.email, SHA-256(key))` | replay → `202` + `Idempotent-Replay: true`; other fingerprint → `409 idempotency_key_conflict` |
| 5 | provider configured | otherwise `503 dependency_unavailable`, `details = {dependency: "email_provider", retryable: false}`, no `Retry-After` |
| 6 | quote visible (creator, or `quotes:read:any`) | `404 quote_not_found` |
| 7 | closed body schema, strict mailbox | `422 validation_error` |
| 8 | recipient resolution | `422 delivery_recipient_missing` |
| 9 | effective status `issued` | `409 invalid_state_transition` (`details.status`) |
| 10 | accept | `202` |

Body validation (step 7) follows the frozen Domain §12 order (`404 → 422 →
409`), like every other V2 mutation. It does not run before
authentication. A rejection at any step binds nothing and writes nothing. A
`503` from the readiness gate can still precede everything (§9).

## 4. Authorization

`quotes:delivery:email` plus quote **visibility**. The creator-only rule
(A4) covers draft edit, issue and cancel only. Delivery is a visible-quote
action (Security §2, "Customer communication" profile).

| Caller | Result |
|---|---|
| Own quote + `quotes:delivery:email` | `202` |
| Foreign quote + `quotes:read:any` + `quotes:delivery:email` | `202` |
| Foreign quote + `quotes:delivery:email` without `quotes:read:any` | `404 quote_not_found` |
| `quotes:read:any` without `quotes:delivery:email` | `403 forbidden` |
| `principalType: operator` without the scope | `403 forbidden` |

`GET …/deliveries/{deliveryId}`:

- requires `quotes:read`;
- a non-visible quote returns `404 quote_not_found` (existence hiding);
- a visible quote with an unknown delivery, or a delivery that belongs to
  another quote, returns `404 delivery_not_found`.

There is no delivery list endpoint, and the quote representation does not
embed deliveries.

## 5. Recipient

- **Validation.** `recipient.email` uses the V2 customer-email validator
  (`z.email().max(254)`). It also has to pass a single-mailbox guard that
  rejects whitespace, control characters, `<>,;:"()[]\` and any second `@`.
  The V1 `normalizeEmailAddress` is not used: it accepted
  `a>,<victim@evil.com` (pre-flight audit §27), which is now `422`.
  `recipient.name` is contract `Text` (≤ 200, no control characters).
- **Resolution.**
  - `recipient.email` is used with `recipient.name` or null. A customer name
    is never attached to an address the caller chose.
  - Otherwise the frozen `customer.email` is used, with the customer's person
    name: `displayName` for guest/person, `contactName` for company (never
    `legalName`), otherwise null.
  - Otherwise `422 delivery_recipient_missing`.
  - A stored customer email that fails the strict check (only possible in
    migrated data) is not used.
- **Snapshot.** `recipient_email`, `recipient_name` and `recipient_masked`
  are stored on the delivery and never re-resolved. No customer or CRM
  service is called.
- **Masking.** The first two characters of the local part, then `***@`, then
  the domain (`camila.rojas@example.com` becomes `ca***@example.com`, as in
  the contract example). A local part of one or two characters shows only
  its first character. If the result would exceed 254 characters, the domain
  is masked too (`a***@***`).
- **Exposure.** The raw address and name never appear in a response, an
  audit event, an error or a log. Only `recipientMasked` is public.

## 6. Request transaction

One PostgreSQL transaction under the per-scope advisory lock:

1. binding lookup;
2. `SELECT … FOR UPDATE` of the visible quote row;
3. body validation and recipient resolution;
4. effective status `issued` (read-time expiry projection: `now ≥
   validUntilExclusive` is `expired`);
5. the committed manifest's `pdf_sha256`;
6. `INSERT quote_deliveries`: `pending`, `origin v2`, `channel email`,
   `generation 0`, `attempt_count 0`, `next_attempt_at = requested_at =
   updated_at = now()` (database time), no lease, no provider id;
7. audit `quote.delivery.requested`;
8. binding (`resource_type = delivery`).

All of it commits, or none of it does.

- **Pinned document.** `document_sha256` is the committed manifest's
  `pdf_sha256`. The request never renders, never reads or writes document
  storage and never creates a document. The delivery suite spies on the
  renderer and the store to prove it.
- **Quote unchanged.** No status, version, timestamp or document change. The
  row lock only serializes the request with T8.
- **Cancel race.** Both the request and the cancel lock the quote row before
  reading its state. Either the cancel sees the new `pending` delivery and
  fails it, or the request sees `cancelled` and gets `409`. A concurrent test
  checks that a cancelled quote never keeps a `pending` delivery.

### Audit

| Event | Principal | Data |
|---|---|---|
| `quote.delivery.requested` | requester | `{deliveryId, documentSha256}` |
| `quote.delivery.failed` (T8) | cancelling principal | `{deliveryId, errorCode: "quote_cancelled"}` |

Both events carry the key hash and correlation of the producing request,
`operationId = null` and no quote transition (`fromStatus`/`toStatus` null).
No recipient, name, subject or content is ever recorded.

## 7. Idempotency

The operation is `quote.delivery.email`. The scope is `(principal, operation,
SHA-256(key))`. The fingerprint is `SHA-256(JCS({operation, pathParameters:
{quoteId}, body}))` over the unmodified body.

- **Same key, same body.** `202`, the same `deliveryId`, the delivery's
  current state, `Idempotent-Replay: true` and audit `idempotency.replayed`.
  No second row and no second `quote.delivery.requested`. A replay never
  sends anything.
- **Same key, different body.** `409 idempotency_key_conflict`.
- **Different principals.** Independent scopes.
- **Concurrency.** Eight concurrent first requests with one key produce one
  delivery, one binding and one requested event (real PostgreSQL test).
- **Rejections.** No `4xx` and no provider-disabled `503` ever binds a key.
- **Lookup.** `GET /v2/idempotency/current?operation=quote.delivery.email`
  returns `resourceType: delivery` and `deliveryId`.

Command idempotency is not a guarantee about the external side effect. R1.6B
owns the send guarantee, which is "at most one automatic provider acceptance
per delivery; ambiguous → `unknown`" (pre-flight audit §12).

## 8. Provider not configured (A6 ordering)

The provider check runs **after** the binding lookup. Consequences:

- A key bound while a provider was configured keeps replaying (`202`, same
  delivery) after the provider is disabled. A conflicting body under that key
  is still `409`.
- A new key while the provider is disabled returns `503 email_provider`, with
  no row, no binding and no audit.
- With the provider disabled, visibility, body and state are not evaluated
  (`503` before `404`/`422`/`409`). `401` and `403` still come first.

> **Superseded by R1.6B** ([email-delivery-execution.md](email-delivery-execution.md)):
> `QUOTE_EMAIL_PROVIDER=gmail` now composes the Gmail adapter and the send
> runner; `disabled` (default) still answers `503 email_provider`. The
> paragraph below records the R1.6A state.

Production in R1.6A composes **no** sender for any `QUOTE_EMAIL_PROVIDER`
value. With `gmail` configured, the service logs
`email.provider_not_available` at startup and still rejects requests with
`503`. That avoids queuing deliveries that only a future release would send.
Only a test composition (`BuildApplicationOverrides.testMailSender`) makes
requests acceptable. `/health/dependencies` keeps reporting `emailProvider:
disabled`, because health describes delivery *execution* (R1.6B).

## 9. T8: cancel of an issued quote

Unchanged rule: deliveries still `pending` become `failed` with
`last_error_code = quote_cancelled`. A delivery that already left `pending`
(`sending`, a future R1.6B state) is not touched.

New in R1.6A: in the same transaction, one `quote.delivery.failed` audit
event per failed delivery, after the `quote.cancelled` event. A replayed
cancel is answered from its binding and adds none. A second cancel is `409`.
The quote moves exactly once (the cancel itself). Draft (T7) and
failed-issuance (T11) cancels touch no delivery.

## 10. Interim readiness (to be corrected in R1.6D)

The delivery routes sit behind the existing global business gate (database,
schema, artifact storage, renderer, lifecycle). Queueing needs only
persistence, so a renderer or storage outage currently returns `503` for
delivery requests and reads as well. This is the known interim dependency.
The capability-specific gate is R1.6D (pre-flight audit §21).
`/health/ready` is unchanged.

## 11. Evidence

| Suite | Covers |
|---|---|
| `test/integration/v2-delivery.integration.test.ts` (real PostgreSQL) | authorization matrix; 400/401/403/413; state matrix including the exact validity boundary and materialized expiry; recipient snapshot, fallback, missing, injection; masking and no raw recipient in responses, audit or logs; replay, conflict, 8× concurrency, cross-principal keys, rejections bind nothing; replay returns current state; provider disabled (no state, ordering, replay after disable); pinned hash with renderer/store spies; quote row unchanged; audit shape; GET matrix; T8 audit (single, multiple, replay, `sending` untouched, T7/T11); cancel/request race; real issuance creates zero deliveries. Every response is validated against `openapi.yaml` (AJV 2020, as the contract validator). A spy `MailSenderPort` is composed and asserted **never called** after every test |
| `test/unit/delivery-request.test.ts` | strict mailbox (27 hostile payloads), closed schema, resolution, masking |
| `test/unit/test-seams.test.ts` | `testMailSender` is a constructor-only seam. The runtime closure contains no Gmail or V1 email code. Only `src/app.ts` holds a `MailSenderPort` and never calls `send`. Issuance, document and integrity paths reach no delivery persistence or mail code |
| `scripts/docker-smoke.mjs` phase 14 | production image: `403` without the scope; `503 email_provider` with it; key not bound; GET `404 delivery_not_found`; zero deliveries and bindings |

## 12. Deferred to R1.6B

- The delivery worker (claim → `sending` with lease and generation; fenced
  `sent` / `pending` / `failed` / `unknown`; an expired `sending` lease
  becomes `unknown` and is never re-sent).
- The V2 Gmail adapter behind `MailSenderPort` (timeouts, phase-aware
  outcome, strict headers, RFC 2047, deterministic `Message-ID`).
- The V2 email envelope (no commercial content).
- The attachment from `readVerified` bytes, checked against
  `document_sha256`.
- The retry policy and the claim-time eligibility re-check (A6.1).
- Ambiguous outcomes, including provider HTTP 5xx after submission, become
  `unknown` and are never retried (A6.3).
- Audit `quote.delivery.sent|failed|unknown`.
- `emailProvider` and `emailDelivery` worker health.
- Deletion of the V1 email/domain remnants.
