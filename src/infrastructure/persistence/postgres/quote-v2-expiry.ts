import type { DeliveryQueueMetrics } from "../../../application/quote-v2/delivery/delivery-execution";
import type { PostgresDatabase } from "./postgres";
import { appendAudit } from "./quote-v2-acceptance";

/*
 * Expiry materialization (state machine T9, validity V-6; R1.6D).
 *
 * Reads already project a stored `issued` quote as `expired` once
 * `now >= valid_until_exclusive` (expiry.ts); this makes the stored state and
 * the audit trail converge. Per quote: `issued → expired`,
 * `expired_at = valid_until_exclusive` (the contractual boundary, never the
 * run time), `version + 1`, `updated_at` = database time, one `quote.expired`
 * audit event (principal `system`). No other side effect: the document and
 * any deliveries are untouched (a pending delivery of an expired quote is
 * failed by the delivery claim, A6.1/W2).
 *
 * Coordination is PostgreSQL only: one bounded batch per transaction, picked
 * through the `quotes_issued_validity_idx` partial index with
 * `FOR UPDATE SKIP LOCKED`. A quote held by a cancel, another expiry worker or
 * any quote-locking transaction is skipped, never waited on, so parallel
 * instances never block each other and each quote transitions once. A row
 * changed and committed by another transaction after this statement's
 * snapshot is re-checked against `status = 'issued'` once locked (READ
 * COMMITTED), so a quote that was cancelled or already expired is never
 * transitioned again. Re-running is a no-op for materialized quotes.
 *
 * Time: the database clock (never the injected read clock: test clocks only
 * steer the read projection). It is read once and bound as a parameter so the
 * planner can use the partial index (`clock_timestamp()` is volatile).
 */

const DB_NOW = `date_trunc('milliseconds', clock_timestamp())`;
const SYSTEM_PRINCIPAL = "system";

type Database = Pick<PostgresDatabase, "withTransaction" | "query">;

export interface MaterializedExpiry {
  readonly quoteId: string;
  readonly version: number;
  readonly expiredAt: Date;
}

interface CandidateRow {
  quote_id: string;
  quote_number: string;
  version: number;
  current_operation_id: string | null;
  valid_until_exclusive: Date;
}

export async function materializeExpiredQuotes(database: Database, limit: number): Promise<MaterializedExpiry[]> {
  return database.withTransaction(async (client) => {
    const { rows: clock } = await client.query<{ now: Date }>(`select ${DB_NOW} as now`);
    const now = clock[0]!.now;
    const { rows } = await client.query<CandidateRow>(
      `select quote_id, quote_number, version, current_operation_id, valid_until_exclusive
       from quote_service.quotes
       where status = 'issued' and valid_until_exclusive <= $1
       order by valid_until_exclusive, quote_id
       limit $2
       for update skip locked`,
      [now, limit]
    );
    const materialized: MaterializedExpiry[] = [];

    for (const row of rows) {
      await client.query(
        `update quote_service.quotes
         set status = 'expired', expired_at = valid_until_exclusive, version = version + 1, updated_at = $2
         where quote_id = $1`,
        [row.quote_id, now]
      );
      await appendAudit(client, {
        quoteId: row.quote_id,
        type: "quote.expired",
        principalId: SYSTEM_PRINCIPAL,
        operationId: row.current_operation_id,
        correlationId: null,
        keyHash: null,
        fromStatus: "issued",
        toStatus: "expired",
        // Minimal non-PII data (Domain §11).
        data: { quoteNumber: row.quote_number, previousVersion: row.version, version: row.version + 1 }
      });
      materialized.push({ quoteId: row.quote_id, version: row.version + 1, expiredAt: row.valid_until_exclusive });
    }

    return materialized;
  });
}

/**
 * `workers.expiry` metrics: stored `issued` quotes whose validity boundary has
 * passed (still to be materialized), and seconds since the oldest such
 * boundary. Read only; served by the same partial index.
 */
export async function expiryQueueMetrics(database: Database): Promise<DeliveryQueueMetrics> {
  const { rows } = await database.query<{ depth: number; oldest: number | null }>(
    `with clock as materialized (select ${DB_NOW} as now)
     select count(q.quote_id)::int as depth,
            floor(extract(epoch from (k.now - min(q.valid_until_exclusive))))::int as oldest
     from clock k
     left join quote_service.quotes q on q.status = 'issued' and q.valid_until_exclusive <= k.now
     group by k.now`
  );
  const row = rows[0]!;
  return { queueDepth: row.depth, oldestPendingAgeSeconds: row.oldest === null ? null : Math.max(0, row.oldest) };
}
