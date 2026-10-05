# Validity Policy `cl-retail-5-calendar-days-v1`

Status: **FROZEN (R1.2)**. Normative. Shapes: [openapi.yaml](openapi.yaml)
(`Validity`, `ValidityOverrideInput`).

## 1. Definition

| Attribute | Value |
|---|---|
| `policyId` | `cl-retail-5-calendar-days-v1` (the version is part of the id; a change of any rule below is a new id) |
| Issuer zone | `America/Santiago` (IANA tzdb). The zone of the issuer, never of the customer or the shipping destination |
| Duration | 5 Chile civil calendar dates |
| Start | The **issue effective instant** `issuedAt`: the transaction timestamp of the issue acceptance commit (create-and-issue or issue of a draft). Never the draft creation time, never the document generation time |
| Day 1 | The civil date of `issuedAt` in the issuer zone, whatever the time of day |
| Last valid date | `validThroughLocalDate = issueLocalDate + 4 days` (inclusive) |
| Boundary | `validUntilExclusive` = the earliest instant whose civil date in the issuer zone is `issueLocalDate + 5 days` |
| Expiry predicate | expired ⇔ `now ≥ validUntilExclusive` |
| Default for | Every issue unless a privileged override is accepted |

Rules:

- **V-1** Calendar arithmetic is performed on civil dates; the boundary is
  then converted to an instant with the IANA tzdb. Implementations MUST NOT
  compute validity as `issuedAt + N × 24 h` or with a fixed UTC offset.
- **V-2** If local midnight does not exist on the boundary date (clocks jump
  forward at 00:00), the boundary is the first existing instant of that date
  (e.g. 01:00). If local times repeat around midnight, the boundary is still
  the earliest instant carrying the new date. The definition in §1 covers
  both cases without special handling.
- **V-3** Resolved once, inside the acceptance transaction, and frozen in the
  quote: `source`, `policyId`, `issuerZone`, `tzdbVersion` (IANA release used,
  e.g. `2025a`), `issueLocalDate`, `validThroughLocalDate`,
  `validUntilExclusive`. Later tzdb updates, policy changes or configuration
  changes never alter a frozen validity.
- **V-4** The API stores and returns `validUntilExclusive` as an RFC 3339 UTC
  instant (`Z`) and the two civil dates as `YYYY-MM-DD`.
- **V-5** The document prints the inclusive local date only:
  "Válida hasta el DD/MM/AAAA inclusive (hora de Chile)". It never prints a
  day count, the policy text of another policy, or a UTC date.
- **V-6** Expiry is deterministic: `expiration.expiredAt` is exactly
  `validUntilExclusive` (sole exception: migrated V1 quotes with
  `source = legacy_caller_supplied` keep their recorded V1 expiry instant),
  and reads project `expired` as soon as the predicate holds, independently
  of the expiry job (see
  [state machine T9](QUOTE_V2_STATE_MACHINE.md#3-transition-table)).
- **V-7** Callers cannot send `validUntil`. A `validUntil` member is an
  unknown request member (`422 validation_error`).

## 2. Privileged override

Scope `quotes:validity:override`. Request member
`validityOverride {validThroughLocalDate, reasonCode, note?}` on
`POST /v2/quotes` or `POST /v2/quotes/{id}/issue`.

- `validThroughLocalDate` is the inclusive last valid civil date in the issuer
  zone; the boundary is resolved exactly as in §1 for the following date.
- Constraint: `issueLocalDate ≤ validThroughLocalDate ≤ issueLocalDate + 365 days`,
  evaluated against the acceptance `issuedAt`; otherwise `422 validation_error`
  (`fields[].code = "override_out_of_range"`) and nothing is committed.
- Without the scope: `403 forbidden` (`details.requiredScope =
  "quotes:validity:override"`), nothing committed.
- Frozen as `source = "override"`, `policyId = null`, `override =
  {principalId, reasonCode}`; the note is audit-only.
- Consumers whose purpose is standard retail quoting are not granted this
  scope.

## 3. Worked examples

Computed with Node.js 20 Intl (tzdb `2025a`) using the reference algorithm in
§4 and re-checked by the contract validator
([freeze record §4](QUOTE_V2_CONTRACT_FREEZE.md#4-static-validation-performed)).
Chile rules in that release: DST starts on the first Sunday on or after
2 September at 04:00 UTC (local 00:00 → 01:00) and ends on the first Sunday on
or after 2 April at 03:00 UTC (local 00:00 → 23:00 of the previous day).
Implementation tests MUST compute these with the tz library, not hard-code
offsets.

| # | `issuedAt` (UTC) | Local issue time | `issueLocalDate` | `validThroughLocalDate` | `validUntilExclusive` | Local boundary | Elapsed |
|---|---|---|---|---|---|---|---|
| E1 | 2026-10-04T18:00:00Z | 15:00 −03:00 | 2026-10-04 | 2026-10-08 | 2026-10-09T03:00:00Z | 2026-10-09 00:00 −03:00 | 105 h |
| E2 | 2026-10-05T02:30:00Z | 23:30 −03:00 (Oct 4) | 2026-10-04 | 2026-10-08 | 2026-10-09T03:00:00Z | 2026-10-09 00:00 −03:00 | 96.5 h |
| E3 | 2026-10-05T03:00:00Z | 00:00 −03:00 (Oct 5) | 2026-10-05 | 2026-10-09 | 2026-10-10T03:00:00Z | 2026-10-10 00:00 −03:00 | 120 h |
| E4 | 2027-04-03T12:00:00Z | 09:00 −03:00 | 2027-04-03 | 2027-04-07 | 2027-04-08T04:00:00Z | 2027-04-08 00:00 −04:00 | 112 h (spans the 25-hour local day) |
| E5 | 2027-04-01T13:00:00Z | 10:00 −03:00 | 2027-04-01 | 2027-04-05 | 2027-04-06T04:00:00Z | 2027-04-06 00:00 −04:00 | 111 h |
| E6 | 2027-08-31T16:00:00Z | 12:00 −04:00 | 2027-08-31 | 2027-09-04 | 2027-09-05T04:00:00Z | **2027-09-05 01:00 −03:00** (00:00 does not exist) | 108 h |
| E7 | 2027-09-01T12:00:00Z | 08:00 −04:00 | 2027-09-01 | 2027-09-05 | 2027-09-06T03:00:00Z | 2027-09-06 00:00 −03:00 | 111 h |

E1/E2 show day 1 is the whole civil date; E2/E3 show the midnight edge; E4
and E5 cross the April transition (one 25-hour local day); E6 resolves a
boundary on a date whose local midnight is skipped; E7 crosses the September
transition (one 23-hour local day). None is a multiple of 24 h from
`issuedAt`.

## 4. Reference algorithm

```
issueLocalDate        = civilDate(issuedAt, zone)
validThroughLocalDate = issueLocalDate + (5 − 1) days        // civil-date arithmetic
boundaryDate          = issueLocalDate + 5 days
validUntilExclusive   = min { t : civilDate(t, zone) = boundaryDate }
                        // = startOfDay(boundaryDate, zone) with "earliest valid instant" disambiguation
```

`civilDate` is monotone non-decreasing in `t`, so the minimum exists and is
found by any tz library's start-of-day function using the "earliest instant"
disambiguation (e.g. `Temporal.PlainDate.toZonedDateTime` with
`disambiguation: "earlier"` for repeated times and the next valid instant for
skipped times).

## 5. Required tests (implementation)

Unit tests with a pinned tzdb release for E1–E7, for each transition of the
current and next calendar year, and for the override range limits; an
integration test asserting that a change of server time zone (`TZ`) does not
change any result; a property test asserting
`validUntilExclusive − issuedAt ∈ (96 h − 1 h, 120 h + 1 h]` and that the
boundary is always the first instant of its local date.
