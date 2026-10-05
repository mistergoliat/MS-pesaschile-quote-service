/**
 * Validity policy cl-retail-5-calendar-days-v1 (docs/v2/QUOTE_V2_VALIDITY_POLICY.md).
 * Civil-date arithmetic in the issuer zone, boundary converted to an instant
 * with the runtime's IANA tzdb (Intl). Never N × 24 h, never a fixed offset.
 */

export const VALIDITY_POLICY_ID = "cl-retail-5-calendar-days-v1";
export const ISSUER_ZONE = "America/Santiago";
const POLICY_DAYS = 5;
const MAX_OVERRIDE_DAYS = 365;

const civilFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ISSUER_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/** Civil date (YYYY-MM-DD) of an instant in the issuer zone. */
export function civilDate(instantMs: number): string {
  return civilFormat.format(new Date(instantMs));
}

export function addDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Earliest instant whose civil date is `localDate` (V-2: a skipped local
 * midnight yields the first existing instant of that date). civilDate is
 * monotone in time, so a binary search over ±14 h of UTC midnight is exact.
 */
export function startOfLocalDate(localDate: string): number {
  const utcMidnight = Date.parse(`${localDate}T00:00:00Z`);
  let low = utcMidnight - 14 * 3_600_000;
  let high = utcMidnight + 14 * 3_600_000;

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);

    if (civilDate(middle) >= localDate) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return high;
}

/** RFC 3339 UTC instant, fractional seconds only when non-zero (contract `Instant`). */
export function formatInstant(instant: Date | number): string {
  return new Date(instant).toISOString().replace(".000Z", "Z");
}

/** IANA tzdb release bundled with this runtime (e.g. "2025a"). */
export function tzdbVersion(): string {
  return process.versions.tz ?? "unknown";
}

export interface ValidityOverride {
  readonly validThroughLocalDate: string;
  readonly reasonCode: string;
}

export interface ResolvedValidity {
  readonly source: "policy" | "override";
  readonly policyId: string | null;
  readonly issuerZone: string;
  readonly tzdbVersion: string;
  readonly issueLocalDate: string;
  readonly validThroughLocalDate: string;
  readonly validUntilExclusive: string;
  readonly override: { readonly principalId: string; readonly reasonCode: string } | null;
}

/** Thrown when an override date falls outside issueLocalDate … +365 days. */
export class OverrideOutOfRangeError extends Error {
  override readonly name = "OverrideOutOfRangeError";
}

/**
 * Resolved once, at the issue effective instant, and frozen (V-3).
 * `override` is only passed for principals already authorized to override.
 */
export function resolveValidity(
  issuedAtMs: number,
  override?: ValidityOverride & { readonly principalId: string }
): ResolvedValidity {
  const issueLocalDate = civilDate(issuedAtMs);

  if (override) {
    const through = override.validThroughLocalDate;

    if (through < issueLocalDate || through > addDays(issueLocalDate, MAX_OVERRIDE_DAYS)) {
      throw new OverrideOutOfRangeError("validThroughLocalDate is outside the permitted override range");
    }
  }

  const validThroughLocalDate = override?.validThroughLocalDate ?? addDays(issueLocalDate, POLICY_DAYS - 1);

  return {
    source: override ? "override" : "policy",
    policyId: override ? null : VALIDITY_POLICY_ID,
    issuerZone: ISSUER_ZONE,
    tzdbVersion: tzdbVersion(),
    issueLocalDate,
    validThroughLocalDate,
    validUntilExclusive: formatInstant(startOfLocalDate(addDays(validThroughLocalDate, 1))),
    override: override ? { principalId: override.principalId, reasonCode: override.reasonCode } : null
  };
}
