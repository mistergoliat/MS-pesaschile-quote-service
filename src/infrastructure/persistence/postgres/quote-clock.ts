import type { SqlQueryable } from "./postgres";

/**
 * The single time authority for expiry evaluation (state machine T8/T9).
 * Production reads the database clock inside the caller's transaction, so
 * reads, list filters and cancellation ("evaluated against the transaction
 * clock") agree and no host clock skew enters the decision. Tests inject a
 * fixed clock.
 */
export interface QuoteClock {
  now(queryable: SqlQueryable): Promise<Date>;
}

/**
 * Database clock, read when called (clock_timestamp, not the transaction
 * start): a cancellation that waited on the quote row lock is evaluated at the
 * instant it holds the lock, never at an earlier one. Millisecond precision,
 * like every instant the service persists; validity boundaries are
 * millisecond-aligned, so truncation never moves an instant across one.
 */
export const databaseClock: QuoteClock = {
  async now(queryable) {
    const { rows } = await queryable.query<{ now: Date }>(`select date_trunc('milliseconds', clock_timestamp()) as now`);
    return rows[0]!.now;
  }
};
