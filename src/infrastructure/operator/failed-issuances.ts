import type { SqlQueryable } from "../persistence/postgres/postgres";
import { OPERATOR_EXIT, type OperatorResult } from "./operator-plane";

/*
 * issuance:failed (R1.6C, pre-flight §17): read-only list of the quotes that
 * are eligible for an operator retry (T10) right now: quote `issuing` whose
 * CURRENT operation is terminally `failed` (T6 deadline or T12 non-retryable).
 * A failed operation that was already retried is no longer current and is
 * not listed; neither is a failed operation of a quote cancelled under T11.
 *
 * Operational identifiers and codes only: no customer snapshot, lines,
 * amounts, recipients, external correlation or storage data.
 */

export const DEFAULT_FAILED_ISSUANCE_LIMIT = 100;

export interface FailedIssuanceFilter {
  readonly quoteId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly limit?: number | undefined;
}

interface FailedIssuanceRow {
  quote_id: string;
  quote_number: string;
  version: number;
  operation_id: string;
  origin: string;
  retry_of_operation_id: string | null;
  last_error_code: string | null;
  attempt_count: number;
  accepted_at: Date;
  completed_at: Date | null;
  deadline_at: Date;
  snapshot_hash: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export async function listFailedIssuances(database: SqlQueryable, filter: FailedIssuanceFilter): Promise<OperatorResult> {
  const limit = filter.limit ?? DEFAULT_FAILED_ISSUANCE_LIMIT;
  const { rows } = await database.query<FailedIssuanceRow>(
    `select q.quote_id, q.quote_number, q.version, o.operation_id, o.origin, o.retry_of_operation_id, o.last_error_code,
            o.attempt_count, o.accepted_at, o.completed_at, o.deadline_at, o.snapshot_hash
     from quote_service.quotes q
     join quote_service.issuance_operations o on o.operation_id = q.current_operation_id and o.quote_id = q.quote_id
     where q.status = 'issuing' and o.status = 'failed'
       and ($1::uuid is null or q.quote_id = $1::uuid)
       and ($2::uuid is null or o.operation_id = $2::uuid)
       and ($3::text is null or o.last_error_code = $3::text)
     order by o.completed_at, o.operation_id
     limit $4`,
    [filter.quoteId ?? null, filter.operationId ?? null, filter.errorCode ?? null, limit + 1]
  );
  const items = rows.slice(0, limit).map((row) => ({
    quoteId: row.quote_id,
    quoteNumber: row.quote_number,
    version: row.version,
    operationId: row.operation_id,
    origin: row.origin,
    retryOfOperationId: row.retry_of_operation_id,
    lastErrorCode: row.last_error_code,
    attemptCount: row.attempt_count,
    acceptedAt: iso(row.accepted_at),
    completedAt: iso(row.completed_at),
    deadlineAt: iso(row.deadline_at),
    snapshotHash: row.snapshot_hash
  }));

  return {
    exitCode: OPERATOR_EXIT.OK,
    body: { status: "ok", count: items.length, limit, truncated: rows.length > limit, items }
  };
}
