/**
 * Effective (read) status vs persisted status (state machine T9, validity V-6).
 *
 * A stored `issued` quote reads as `expired` once `now ≥ validUntilExclusive`,
 * before the expiry job materializes it, with `expiredAt = validUntilExclusive`.
 * The projection never writes: version, updatedAt, snapshot and document stay
 * as persisted. Only `issued` projects; an `issuing` quote past its validity
 * stays `issuing` until the manifest commits (state machine §3 notes).
 * The instant always comes from the injected `QuoteClock`, never from
 * scattered `Date.now()` calls.
 */

export interface PersistedExpiryState {
  readonly status: string;
  readonly validUntilExclusive: Date | null;
  /** Materialized expiry instant (stored `expired` quotes, incl. migrated V1 ones). */
  readonly expiredAt: Date | null;
}

export interface EffectiveExpiryState {
  readonly status: string;
  readonly expiredAt: Date | null;
}

/** Validity predicate: expired ⇔ now ≥ validUntilExclusive. */
export function isPastValidity(validUntilExclusive: Date | null, now: Date): boolean {
  return validUntilExclusive !== null && now.getTime() >= validUntilExclusive.getTime();
}

export function effectiveExpiry(persisted: PersistedExpiryState, now: Date): EffectiveExpiryState {
  if (persisted.status === "issued" && isPastValidity(persisted.validUntilExclusive, now)) {
    return { status: "expired", expiredAt: persisted.validUntilExclusive };
  }

  return { status: persisted.status, expiredAt: persisted.expiredAt };
}

/**
 * SQL form of the same projection, for filtering in the database.
 * `alias` is the quotes table alias; `nowParameter` a `$n` bound to the clock instant.
 */
export function effectiveStatusSql(alias: string, nowParameter: string): string {
  return `(case when ${alias}.status = 'issued' and ${alias}.valid_until_exclusive <= ${nowParameter}::timestamptz
                then 'expired' else ${alias}.status end)`;
}
