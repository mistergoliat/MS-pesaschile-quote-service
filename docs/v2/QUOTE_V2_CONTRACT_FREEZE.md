# Quote Service V2 — Contract Freeze Record (R1.2)

**CONTRACT_FROZEN = YES** (2026-10-04).

Scope: architecture and contract only. No runtime code, configuration,
database, migration or production system was changed or accessed in R1.2.
R1.3 has not started.

## 1. Inputs

| Input | Status |
|---|---|
| J3A Quote owner audit (`R4-J3A_QUOTE_OWNER_AUDIT.md`, consumer repository) | closed |
| R1.1 production readiness audit (`R4-J3A_QUOTE_SERVICE_R1.1_PRODUCTION_READINESS_AUDIT.md`, consumer repository) | closed |
| Quote Service source | `fade75d` |
| R1.2 decisions 1–25 (domain model, states, flows, numbering, validity, correlation, customer, commercial snapshot, approval freeze, arithmetic, discounts, shipping, PDF, email, storage, idempotency, recovery, health, security, API, success semantics, errors) | applied verbatim |

## 2. Artifact set

| ID | Artifact | File |
|---|---|---|
| A | Domain contract | [QUOTE_V2_DOMAIN_CONTRACT.md](QUOTE_V2_DOMAIN_CONTRACT.md) |
| B | State machine | [QUOTE_V2_STATE_MACHINE.md](QUOTE_V2_STATE_MACHINE.md) |
| C | OpenAPI 3.1 | [openapi.yaml](openapi.yaml) |
| D | Examples (34 files) | [examples/](examples/) |
| E | Idempotency / reconciliation (incl. diagram) | [QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md) |
| F | Validity policy | [QUOTE_V2_VALIDITY_POLICY.md](QUOTE_V2_VALIDITY_POLICY.md) |
| G | Principals and scopes | [QUOTE_V2_SECURITY_SCOPES.md](QUOTE_V2_SECURITY_SCOPES.md) |
| H, I | V1 → V2 mapping; KEEP / CHANGE / DELETE | [QUOTE_V2_V1_MIGRATION.md](QUOTE_V2_V1_MIGRATION.md) |
| J | Roadmap R1.3–R1.7 | [QUOTE_V2_ROADMAP.md](QUOTE_V2_ROADMAP.md) |
| K, L | Checklist, decisions, open items, validation | this file |
| — | Validation and example tooling | [tools/](tools/) |

Example index (D): transactional create-and-issue
(`create-and-issue.request.json`, `…response-201.json`, `…response-202.json`);
draft create (`draft-create.request.json`, `…response-201.json`); draft update
(`draft-update.request.json`); issue (`issue.request.json`,
`issue.response-200.json`); issued quote (`quote-issued.json`); issuing
operation (`operation-issuing.json`); shipping snapshot (`shipping.input.json`,
`shipping.snapshot.json`); customers (`customer.guest.json`,
`customer.guest-with-contact.json`, `customer.person.json`,
`customer.company.json`); idempotency lookup
(`idempotency-lookup.bound.json`, `idempotency-lookup.not-found.json`); typed
errors (`error.*.json`, 8 files); plus list, cancel, delivery, audit and
health examples.

## 3. Contract decisions taken during R1.2

Beyond the 25 given decisions, R1.2 had to fix these to remove ambiguity.
Each is normative and recorded where it lives.

| # | Decision | Where |
|---|---|---|
| C1 | Replays return the bound resource in its **current** state; status code is a function of state (`201/202` create-and-issue, `200/202` issue) plus `Idempotent-Replay: true` | Domain §4.3, Idempotency §3.2 |
| C2 | Bindings have no `in_progress` state: binding and effect commit in one transaction; long work lives in the issuance operation | Idempotency §3.1 |
| C3 | Evaluation order: size/parse → auth → scope → **binding lookup** → 404 → 422 → state → accept; 4xx/503 never bind | Domain §12 |
| C4 | `externalCorrelation.correlationId` excluded from the fingerprint | Idempotency §2 |
| C5 | Fingerprint = SHA-256 of RFC 8785 JCS of `{operation, pathParameters, body′}`; canonical decimal strings enforced by schema | Idempotency §2, OpenAPI |
| C6 | Acceptance timeout 10 s (makes lookup `not_found` decidable) | Idempotency §3.3 |
| C7 | Issuance retries every failure with fixed backoff until a deadline (default 24 h); at the deadline the quote becomes `cancelled` (`issuance_failed`) and the operation `failed` | State machine §6, Idempotency §4 |
| C8 | Inline render budget `syncIssueBudgetMs` (default 5 s) decides `201` vs `202`; never `201` before manifest commit | Domain §4.1, Idempotency §4.4 |
| C9 | `issuedAt` = acceptance commit instant (validity base, printed issue date); document time is `document.generatedAt` | Validity §1 |
| C10 | Expiry is a read projection with `expiredAt = validUntilExclusive`; the job only materializes | State machine T9 |
| C11 | Cancel allowed from `draft` and from `issued` before the validity boundary; rejected while `issuing` | State machine §3–4 |
| C12 | Override expressed as `validThroughLocalDate` (inclusive civil date), range day 1 … +365 days | Validity §2 |
| C13 | Optional `expectedTotals` → `422 arithmetic_mismatch` (lets a consumer bind approved amounts) | Domain §6.3, §17 |
| C14 | Visibility: own quotes, or all with `quotes:read:any`; invisible = 404 | Security §3 |
| C15 | Drafts may have 0 lines; issue requires ≥ 1 | Domain §4.2 |
| C16 | No revisions in V2; change after acceptance = new quote | State machine §5 |
| C17 | No public HTML artifact; document only via authenticated PDF endpoint | Domain §9 |
| C18 | Quantity < 10 000 with ≤ 6 decimals; unit amount ≤ 1 000 000 000 CLP; computed values ≤ 2⁵³−1 | Domain §6.1 |
| C19 | Tax rate in (0, 1]; zero-rated charges use `exempt` | Domain §6.2 |
| C20 | V1 `shipping` lines migrate as `service` lines (no fabricated carrier/destination); pending V1 email deliveries migrate as `failed` so nothing is sent after cutover | Migration §1 |
| C21 | No quote or binding is deleted until a retention policy is ratified | Idempotency §3.4 |

## 4. Static validation performed

Tooling: [tools/validate-contract.mjs](tools/validate-contract.mjs) (ajv 8 /
JSON Schema 2020-12, `yaml`, Node.js 20 Intl with tzdb 2025a);
examples generated by [tools/generate-examples.mjs](tools/generate-examples.mjs)
with the normative integer arithmetic. Run (documentation tooling only, not a
runtime dependency):

```
cd docs/v2/tools && npm install && npm run validate
```

The tooling has its own `package.json`; it adds nothing to the service's
dependencies. Result on 2026-10-04: **437 checks, 437 passed, 0 failed.**

| Requirement | Check(s) | Result |
|---|---|---|
| OpenAPI matches domain document | all `$ref` resolve; every schema compiles; error catalog in Domain §12 == `ErrorCode` enum; every state-machine endpoint exists; doc scope matrix == scopes used | pass |
| Examples validate against schemas | every `externalValue` example validated against its request/response schema; standalone customer/shipping/update/cancel/delivery examples validated; every example file covered | pass |
| Negative cases | 19 invalid payloads rejected (caller `validUntil`, `opportunityId`, non-canonical/zero quantity, float amount, numeric tax rate, exempt with rate, included without rate, reference without type, empty lines, customer kinds, non-CL destination, shipping as string, RUT with dots, statuses `accepted`/`paid`, empty draft update) | pass |
| State transitions match API operations | transition table states == `QuoteStatus`; transition endpoints exist; no expire/accept/paid/revision routes | pass |
| Idempotency non-contradictory | every mutation requires `Idempotency-Key`; each operation name used exactly once; lookup fingerprint recomputed from the create example (JCS, `correlationId` removed) matches; replay/conflict/order rules cross-referenced (manual review) | pass |
| 201/202 explicit | create-and-issue has exactly `201`/`202`; issue has `200`/`202`; `201` example not `issuing`, `202` example `issuing` | pass |
| Validity deterministic | all 7 table rows recomputed with IANA tz (incl. 25-hour day, skipped midnight, 23-hour day); quote examples' validity recomputed | pass |
| Arithmetic | every line, shipping and total in every quote example recomputed with the normative integer formulas; `gross = net + tax`; `expectedTotals` equal owner totals | pass |
| No endpoint requires Opportunity | OpenAPI never mentions it; owner docs/examples free of it | pass |
| No Catalog/Shipping call | no outbound/lookup surface in OpenAPI; D-1/D-2 invariants (manual review) | pass |
| Email cannot happen during issuance | only `POST …/deliveries/email` can queue email; create/issue descriptions state no email; scope `quotes:delivery:email` used only there | pass |
| Issued artifact immutable | D-4, §9.3, state machine T8/T9, no re-render route (manual review) | pass |
| No consumer-platform primitive | owner files and all examples scanned for consumer-platform terms (term list in `tools/validate-contract.mjs`) | pass |

## 5. Contract freeze checklist (K)

- [x] Ownership boundary (Model B) and non-ownership list frozen
- [x] States `draft, issuing, issued, expired, cancelled`; `accepted`/`paid` removed; no public expire
- [x] Transactional and manual flows; `201`/`202` and `200`/`202` semantics
- [x] Quote number allocated at issue acceptance; ≥ 6 digits, never truncated; gaps allowed
- [x] Validity policy `cl-retail-5-calendar-days-v1`, `America/Santiago`, IANA tz, frozen at issue; privileged override only
- [x] Generic `externalCorrelation`; no Opportunity
- [x] Customer `guest | person | company`; no CRM identity; email only for delivery
- [x] Commercial snapshot and line contract; exact representations
- [x] Normative arithmetic (included / excluded / exempt, CLP half-up, totals)
- [x] No discount engine; additive evolution path stated
- [x] Structured shipping snapshot; no call to Shipping
- [x] Approval / price-freeze consumer obligations; no re-pricing surface
- [x] Document content, manifest and immutability rules
- [x] Email separate, explicit, provider disabled initially
- [x] Storage: persistent single-host filesystem, content-addressed, backup
- [x] Idempotency scope, fingerprint, replay, conflict, lookup, retention
- [x] Durable issuance with lease, fencing, backoff, deadline, crash windows
- [x] Health live / ready / dependencies; no crash on DB outage
- [x] Principals, scopes, visibility; no global token as model
- [x] Single canonical V2 API; V1 retired (`410`)
- [x] Formal-quote success evidence
- [x] Typed error catalog and evaluation order
- [x] V1 → V2 mapping; KEEP / CHANGE / DELETE
- [x] Roadmap R1.3–R1.7
- [x] Static validation green

## 6. Remaining unresolved items (L)

None of these changes an endpoint, a schema, a state or an invariant; each is
bounded by a frozen rule and owned by a later slice.

| # | Item | Frozen bound | Needed by |
|---|---|---|---|
| U1 | Retention/deletion period for customer snapshots, documents and bindings | Nothing is deleted until ratified; any policy must keep binding tombstones (C21) | Before production data accumulates (R1.6/R1.7) |
| U2 | Exact PDF tax label wording (finance/accounting review) | When a global VAT statement may appear and that per-charge bases are labeled (Domain §9.1) | R1.5 template work |
| U3 | Issuer profile content on the document (legal name, issuer RUT, address, contact) | Comes from issuer profile `pesaschile-cl-v1`; not caller-supplied | R1.5 template work |
| U4 | Outcome of the consumer and data inventory (deployed V1 callers, live/backup rows, document files) | Mapping in the migration document applies to whatever is found; V1 is retired without a shim | R1.7 |
