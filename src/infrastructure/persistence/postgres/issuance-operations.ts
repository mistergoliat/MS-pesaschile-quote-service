import crypto from "node:crypto";

import type { PoolClient } from "pg";

import {
  ISSUANCE_DEADLINE_EXCEEDED,
  issuanceBackoffMs,
  OPERATOR_REASON_CODE_PATTERN,
  type AttemptFailure,
  type ClaimResult,
  type CommitIssuedResult,
  type DeadlineFailure,
  type FailAttemptResult,
  type IssuanceOperationRepository,
  type IssuedDocumentInput,
  type OperationFence,
  type OperatorRetryInput,
  type OperatorRetryResult,
  type RenewResult
} from "../../../application/quote-v2/issuance-operation";
import type { IssuanceFailpoints } from "../../../application/quote-v2/issuance-failpoints";
import {
  ISSUED_SNAPSHOT_HASH_ALGORITHM,
  issuedSnapshotHash,
  SnapshotIntegrityError,
  type IssuedSnapshot
} from "../../../application/quote-v2/issued-snapshot";
import { loadIssuedSnapshot, loadVerifiedIssuedSnapshot } from "./issued-snapshot-loader";
import { CommitOutcomeUnknownError, type PostgresDatabase } from "./postgres";
import { appendAudit } from "./quote-v2-acceptance";

/*
 * PostgreSQL implementation of the issuance operation core (R1.5B1).
 * PostgreSQL is the only coordinator: no in-memory lock decides who holds an
 * operation. Contract: Idempotency §4.3 (claim, renew, fail, deadline sweep),
 * state machine T6/T10.
 *
 * Lock order, everywhere a transaction takes both rows: quote row first, then
 * the operation row (cancel, operator retry, fail-attempt, deadline sweep and
 * the B3 manifest commit). The claim and the lease renewal lock only the
 * operation row and never wait on it (SKIP LOCKED / single-row update), so no
 * cycle is possible.
 *
 * Time: every decision uses the database clock read after the locks are
 * held, at millisecond precision like every instant the service persists.
 */

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error).code === "23505";

/** Database clock at the instant a statement runs (not the transaction start). */
const DB_NOW = `date_trunc('milliseconds', clock_timestamp())`;
const SYSTEM_PRINCIPAL = "system";

type Database = Pick<PostgresDatabase, "withTransaction" | "query">;

export interface IssuanceOperationRepositoryConfig {
  readonly leaseMs: number;
  /** Deadline of operations created by an operator retry (T10). */
  readonly deadlineMs: number;
  /** Test compositions only (issuance-failpoints.ts); production passes nothing. */
  readonly failpoints?: IssuanceFailpoints | undefined;
}

interface OperationStateRow {
  status: string;
  generation: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  deadline_at: Date;
  next_attempt_at: Date | null;
  attempt_count: number;
  now: Date;
}

interface ClaimRow {
  operation_id: string;
  quote_id: string;
  generation: string;
  attempt_count: number;
  lease_owner: string;
  lease_expires_at: Date;
  deadline_at: Date;
  snapshot_hash: string;
  previous_status: "pending" | "running";
}

const fenceHolds = (row: OperationStateRow | undefined, fence: OperationFence): boolean =>
  row !== undefined && row.status === "running" && Number(row.generation) === fence.generation && row.lease_owner === fence.leaseOwner;

export class PostgresIssuanceOperationRepository implements IssuanceOperationRepository {
  constructor(
    private readonly database: Database,
    private readonly config: IssuanceOperationRepositoryConfig
  ) {}

  /**
   * One statement: pick the oldest due candidate with `FOR UPDATE SKIP LOCKED`
   * and transition it. Eligible only while the quote is `issuing`, the
   * operation is the quote's current one and `now < deadline_at`; either
   * `pending` and due, or `running` with an expired lease (reclaim: same
   * operation, next generation). Under READ COMMITTED a row changed by a
   * concurrent claimer after our snapshot is re-checked against the predicate
   * once locked, so two claimers can never both transition it.
   */
  claimNext(leaseOwner: string): Promise<ClaimResult> {
    return this.claim(leaseOwner, null);
  }

  /** Inline path: the same eligibility and transition, for one operation only. */
  claimOperation(operationId: string, leaseOwner: string): Promise<ClaimResult> {
    return this.claim(leaseOwner, operationId);
  }

  private async claim(leaseOwner: string, operationId: string | null): Promise<ClaimResult> {
    let claimed: ClaimRow | undefined;

    try {
      claimed = await this.database.withTransaction(async (client) => {
        const { rows } = await client.query<ClaimRow>(
          `with clock as materialized (select ${DB_NOW} as now),
           candidate as (
             select o.operation_id, o.status as previous_status
             from quote_service.issuance_operations o
             join quote_service.quotes q on q.quote_id = o.quote_id and q.current_operation_id = o.operation_id
             where q.status = 'issuing'
               and ($3::uuid is null or o.operation_id = $3::uuid)
               and (select now from clock) < o.deadline_at
               and ((o.status = 'pending' and o.next_attempt_at <= (select now from clock))
                 or (o.status = 'running' and o.lease_expires_at < (select now from clock)))
             order by coalesce(o.next_attempt_at, o.lease_expires_at), o.operation_id
             limit 1
             for update of o skip locked
           )
           update quote_service.issuance_operations o
           set status = 'running', generation = o.generation + 1, attempt_count = o.attempt_count + 1,
               lease_owner = $1, lease_expires_at = least(k.now + $2 * interval '1 millisecond', o.deadline_at),
               last_attempt_at = k.now, next_attempt_at = null, updated_at = k.now
           from candidate c, clock k
           where o.operation_id = c.operation_id
           returning o.operation_id, o.quote_id, o.generation::text as generation, o.attempt_count, o.lease_owner,
                     o.lease_expires_at, o.deadline_at, o.snapshot_hash, c.previous_status`,
          [leaseOwner, this.config.leaseMs, operationId]
        );
        return rows[0];
      });
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }

      // We cannot know which row the statement picked; the lease owner is
      // unique to this process, so a running operation leased to us that we
      // do not know about can only be this claim. Adopting it is safe (we hold
      // the current generation); not finding one means nothing was applied.
      const { rows } = await this.database.query<ClaimRow>(
        `select operation_id, quote_id, generation::text as generation, attempt_count, lease_owner, lease_expires_at,
                deadline_at, snapshot_hash, 'pending' as previous_status
         from quote_service.issuance_operations
         where status = 'running' and lease_owner = $1 and ($2::uuid is null or operation_id = $2::uuid)
         order by last_attempt_at desc limit 1`,
        [leaseOwner, operationId]
      );
      claimed = rows[0];
    }

    if (!claimed) {
      return { kind: "NONE_AVAILABLE" };
    }

    return {
      kind: "CLAIMED",
      attempt: {
        operationId: claimed.operation_id,
        quoteId: claimed.quote_id,
        generation: Number(claimed.generation),
        leaseOwner: claimed.lease_owner,
        attemptCount: claimed.attempt_count,
        leaseExpiresAt: claimed.lease_expires_at,
        deadlineAt: claimed.deadline_at,
        snapshotHash: claimed.snapshot_hash,
        reclaimed: claimed.previous_status === "running"
      }
    };
  }

  /** Fenced renewal to `min(now + lease, deadline_at)`; never past the deadline. */
  async renewLease(fence: OperationFence): Promise<RenewResult> {
    try {
      const renewed = await this.database.withTransaction(async (client) => {
        const { rows } = await client.query<{ lease_expires_at: Date }>(
          `with clock as materialized (select ${DB_NOW} as now)
           update quote_service.issuance_operations o
           set lease_expires_at = least(k.now + $4 * interval '1 millisecond', o.deadline_at), updated_at = k.now
           from clock k
           where o.operation_id = $1 and o.generation = $2 and o.status = 'running' and o.lease_owner = $3
             and k.now < o.deadline_at
           returning o.lease_expires_at`,
          [fence.operationId, fence.generation, fence.leaseOwner, this.config.leaseMs]
        );
        return rows[0];
      });

      if (renewed) {
        return { kind: "RENEWED", leaseExpiresAt: renewed.lease_expires_at };
      }
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }
    }

    // Not renewed (or commit outcome unknown): classify from durable state.
    const state = await this.readState(this.database, fence.operationId);

    if (!state || !fenceHolds(state, fence)) {
      return { kind: "STALE_FENCE" };
    }

    return state.now >= state.deadline_at ? { kind: "DEADLINE_REACHED" } : { kind: "RENEWED", leaseExpiresAt: state.lease_expires_at! };
  }

  /**
   * Fenced end of a failed attempt (Idempotency §4.3, amendment A5):
   * - non-retryable (T12): terminally `failed` with the attempt's code and
   *   `completed_at`, audit `quote.issue.failed`;
   * - retryable, before the deadline: `running → pending`, lease cleared,
   *   `next_attempt_at = min(now + backoff(attempt_count), deadline_at)`,
   *   audit `quote.issue.attempt_failed`;
   * - retryable, at or after the deadline: terminally `failed`
   *   (`issuance_deadline_exceeded`), audit `quote.issue.failed`.
   * The quote is never touched: it stays `issuing` (A1), keeps its number and
   * gets no new operation.
   */
  async failAttempt(fence: OperationFence, failure: AttemptFailure): Promise<FailAttemptResult> {
    const errorCode = failure.errorCode;

    try {
      return await this.database.withTransaction(async (client) => {
        const state = await this.lockOperation(client, fence.operationId);

        if (!state || !fenceHolds(state.operation, fence)) {
          return { kind: "STALE_FENCE" } as const;
        }

        const { quoteId, operation } = state;

        if (!failure.retryable) {
          await client.query(
            `update quote_service.issuance_operations
             set status = 'failed', last_error_code = $4, completed_at = $5, lease_owner = null, lease_expires_at = null,
                 next_attempt_at = null, updated_at = $5
             where operation_id = $1 and generation = $2 and status = 'running' and lease_owner = $3`,
            [fence.operationId, fence.generation, fence.leaseOwner, errorCode, operation.now]
          );
          await appendAudit(client, {
            quoteId,
            type: "quote.issue.failed",
            principalId: SYSTEM_PRINCIPAL,
            operationId: fence.operationId,
            correlationId: null,
            keyHash: null,
            fromStatus: "issuing",
            toStatus: "issuing",
            data: { errorCode, retryable: false, reason: failure.reason, attempts: operation.attempt_count, generation: fence.generation }
          });
          return { kind: "FAILED_NON_RETRYABLE" } as const;
        }

        if (operation.now >= operation.deadline_at) {
          await this.markDeadlineFailed(client, fence.operationId, operation.now, false);
          await appendAudit(client, {
            quoteId,
            type: "quote.issue.failed",
            principalId: SYSTEM_PRINCIPAL,
            operationId: fence.operationId,
            correlationId: null,
            keyHash: null,
            fromStatus: "issuing",
            toStatus: "issuing",
            data: {
              errorCode: ISSUANCE_DEADLINE_EXCEEDED,
              lastAttemptErrorCode: errorCode,
              attempts: operation.attempt_count,
              generation: fence.generation
            }
          });
          return { kind: "DEADLINE_REACHED" } as const;
        }

        const backoffMs = issuanceBackoffMs(operation.attempt_count);
        const { rows } = await client.query<{ next_attempt_at: Date }>(
          `update quote_service.issuance_operations
           set status = 'pending', lease_owner = null, lease_expires_at = null, last_error_code = $4,
               next_attempt_at = least($5::timestamptz + $6 * interval '1 millisecond', deadline_at), updated_at = $5
           where operation_id = $1 and generation = $2 and status = 'running' and lease_owner = $3
           returning next_attempt_at`,
          [fence.operationId, fence.generation, fence.leaseOwner, errorCode, operation.now, backoffMs]
        );
        const nextAttemptAt = rows[0]!.next_attempt_at;
        await appendAudit(client, {
          quoteId,
          type: "quote.issue.attempt_failed",
          principalId: SYSTEM_PRINCIPAL,
          operationId: fence.operationId,
          correlationId: null,
          keyHash: null,
          fromStatus: null,
          toStatus: null,
          data: {
            errorCode,
            reason: failure.reason,
            attempt: operation.attempt_count,
            generation: fence.generation,
            retryInMs: nextAttemptAt.getTime() - operation.now.getTime(),
            nextAttemptAt: nextAttemptAt.toISOString()
          }
        });
        return { kind: "RESCHEDULED", nextAttemptAt, attemptCount: operation.attempt_count } as const;
      });
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }

      // failAttempt never changes the generation: still `running` under our
      // fence means it did not commit; any other state at our generation
      // means it did; another generation means we were fenced out anyway.
      const state = await this.readState(this.database, fence.operationId);

      if (fenceHolds(state, fence)) {
        return { kind: "NOT_APPLIED" };
      }

      if (state === undefined || Number(state.generation) !== fence.generation) {
        return { kind: "STALE_FENCE" };
      }

      if (state.status === "pending") {
        return { kind: "RESCHEDULED", nextAttemptAt: state.next_attempt_at!, attemptCount: state.attempt_count };
      }

      return failure.retryable ? { kind: "DEADLINE_REACHED" } : { kind: "FAILED_NON_RETRYABLE" };
    }
  }

  /**
   * T5 (Idempotency §4.3 commit): one transaction, after the PDF bytes are
   * published and re-verified at their content address. Under the quote
   * lock then the operation lock: the fence must still hold (running, same
   * generation and holder), the operation must be the quote's current one and
   * the quote `issuing`. Then: insert the manifest, operation `succeeded`
   * (completed_at, lease cleared), quote `issued` (version + 1), audit
   * `quote.issued`. `generated_at` = `committed_at` = `completed_at` = the
   * database time of this commit (the document becomes formal here).
   *
   * Zero effect otherwise (STALE_FENCE). A COMMIT whose outcome is unknown is
   * reconciled from durable state: committed (our operation succeeded with a
   * manifest) → COMMITTED; still ours and untouched → the commit is retried
   * once; anything else → STALE_FENCE / NOT_APPLIED, never a guess.
   */
  async commitIssued(fence: OperationFence, document: IssuedDocumentInput): Promise<CommitIssuedResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.withTransaction((client) => this.commitIssuedTx(client, fence, document));
      } catch (error) {
        const unknownOutcome = error instanceof CommitOutcomeUnknownError;

        if (!unknownOutcome && !isUniqueViolation(error)) {
          throw error;
        }

        const durable = await this.readCommitState(fence.operationId);

        if (durable.status === "succeeded" && durable.manifestOperationId === fence.operationId && durable.generation === fence.generation) {
          return { kind: "COMMITTED", generatedAt: durable.generatedAt! };
        }

        if (!(unknownOutcome && durable.status === "running" && durable.generation === fence.generation && durable.leaseOwner === fence.leaseOwner && !durable.manifestOperationId)) {
          return unknownOutcome ? { kind: "NOT_APPLIED" } : { kind: "STALE_FENCE" };
        }
        // Provably not committed and still ours: retry the commit once.
      }
    }

    return { kind: "NOT_APPLIED" };
  }

  private async commitIssuedTx(client: PoolClient, fence: OperationFence, document: IssuedDocumentInput): Promise<CommitIssuedResult> {
    const state = await this.lockOperation(client, fence.operationId);

    if (!state || !fenceHolds(state.operation, fence)) {
      return { kind: "STALE_FENCE" };
    }

    const { rows: quotes } = await client.query<{ status: string; current_operation_id: string; version: number; quote_number: string; snapshot_hash: string }>(
      `select q.status, q.current_operation_id, q.version, q.quote_number, o.snapshot_hash
       from quote_service.quotes q join quote_service.issuance_operations o on o.operation_id = $2
       where q.quote_id = $1`,
      [state.quoteId, fence.operationId]
    );
    const quote = quotes[0]!;

    if (quote.status !== "issuing" || quote.current_operation_id !== fence.operationId) {
      return { kind: "STALE_FENCE" };
    }

    if (quote.snapshot_hash !== document.semanticSnapshotHash) {
      throw new Error("rendered snapshot hash differs from the operation's accepted snapshot hash");
    }

    const now = state.operation.now;
    await client.query(
      `insert into quote_service.quote_documents (
         document_id, quote_id, operation_id, origin, content_type, semantic_snapshot_hash, semantic_hash_algorithm,
         pdf_sha256, byte_length, renderer_version, template_version, generated_at, storage_key, committed_at
       ) values ($1, $2, $3, 'issuance', 'application/pdf', $4, $5, $6, $7, $8, $9, $10, $11, $10)`,
      [
        crypto.randomUUID(),
        state.quoteId,
        fence.operationId,
        document.semanticSnapshotHash,
        ISSUED_SNAPSHOT_HASH_ALGORITHM,
        document.pdfSha256,
        document.byteLength,
        document.rendererVersion,
        document.templateVersion,
        now,
        document.storageKey
      ]
    );
    await client.query(
      `update quote_service.issuance_operations
       set status = 'succeeded', completed_at = $4, lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = $4
       where operation_id = $1 and generation = $2 and status = 'running' and lease_owner = $3`,
      [fence.operationId, fence.generation, fence.leaseOwner, now]
    );
    await client.query(
      `update quote_service.quotes set status = 'issued', version = version + 1, updated_at = $2
       where quote_id = $1 and status = 'issuing'`,
      [state.quoteId, now]
    );
    await appendAudit(client, {
      quoteId: state.quoteId,
      type: "quote.issued",
      principalId: SYSTEM_PRINCIPAL,
      operationId: fence.operationId,
      correlationId: document.correlationId ?? null,
      keyHash: null,
      fromStatus: "issuing",
      toStatus: "issued",
      data: {
        quoteNumber: quote.quote_number,
        version: quote.version + 1,
        pdfSha256: document.pdfSha256,
        byteLength: document.byteLength,
        rendererVersion: document.rendererVersion,
        templateVersion: document.templateVersion,
        attempts: state.operation.attempt_count
      }
    });
    await this.config.failpoints?.reach("before_t5_commit", { operationId: fence.operationId, generation: fence.generation });

    return { kind: "COMMITTED", generatedAt: now };
  }

  private async readCommitState(operationId: string): Promise<{
    status: string | null;
    generation: number | null;
    leaseOwner: string | null;
    manifestOperationId: string | null;
    generatedAt: Date | null;
  }> {
    const { rows } = await this.database.query<{ status: string; generation: string; lease_owner: string | null; document_operation_id: string | null; generated_at: Date | null }>(
      `select o.status, o.generation::text as generation, o.lease_owner, d.operation_id as document_operation_id, d.generated_at
       from quote_service.issuance_operations o
       left join quote_service.quote_documents d on d.quote_id = o.quote_id
       where o.operation_id = $1`,
      [operationId]
    );
    const row = rows[0];

    return {
      status: row?.status ?? null,
      generation: row ? Number(row.generation) : null,
      leaseOwner: row?.lease_owner ?? null,
      manifestOperationId: row?.document_operation_id ?? null,
      generatedAt: row?.generated_at ?? null
    };
  }

  /**
   * Deadline sweep (T6). Database-only: independent of renderer and storage.
   * Fails `pending` operations at/after their deadline and `running` ones
   * whose lease has expired; a live lease is never pre-empted (claim and
   * renewal cap leases at the deadline, so a lease outlives it by at most the
   * boundary instant). Each operation in its own transaction: generation
   * bump (fences any zombie holder), `failed`, `issuance_deadline_exceeded`,
   * `completed_at`, one `quote.issue.failed`. The quote stays `issuing`.
   * Idempotent: a failed operation is terminal and never selected again.
   */
  async failDeadlineExceeded(limit: number): Promise<DeadlineFailure[]> {
    const { rows: candidates } = await this.database.query<{ operation_id: string }>(
      `select operation_id from quote_service.issuance_operations
       where status in ('pending', 'running') and deadline_at <= ${DB_NOW}
         and (status = 'pending' or lease_expires_at < ${DB_NOW})
       order by deadline_at, operation_id
       limit $1`,
      [limit]
    );
    const failed: DeadlineFailure[] = [];

    for (const { operation_id: operationId } of candidates) {
      const failure = await this.database.withTransaction(async (client) => {
        const state = await this.lockOperation(client, operationId);

        if (!state) {
          return null;
        }

        const { quoteId, operation } = state;
        const due =
          (operation.status === "pending" || operation.status === "running") &&
          operation.now >= operation.deadline_at &&
          (operation.status === "pending" || operation.lease_expires_at! < operation.now);

        if (!due) {
          return null;
        }

        const generation = await this.markDeadlineFailed(client, operationId, operation.now, true);
        await appendAudit(client, {
          quoteId,
          type: "quote.issue.failed",
          principalId: SYSTEM_PRINCIPAL,
          operationId,
          correlationId: null,
          keyHash: null,
          fromStatus: "issuing",
          toStatus: "issuing",
          data: { errorCode: ISSUANCE_DEADLINE_EXCEEDED, attempts: operation.attempt_count, generation }
        });
        return { operationId, quoteId, previousStatus: operation.status as DeadlineFailure["previousStatus"], generation };
      });

      if (failure) {
        failed.push(failure);
      }
    }

    return failed;
  }

  /**
   * T10: a new `operator_retry` operation for the same quote, snapshot,
   * number and validity, with a new deadline; it becomes the quote's current
   * operation (version + 1); audit `quote.issue.accepted` with `retryOf`.
   * The quote row lock serializes retries against each other and against a
   * creator cancel (T11): whichever commits first wins and the other sees the
   * changed state. The partial unique index stays the last line of defence
   * for "one active operation".
   */
  async createOperatorRetry(input: OperatorRetryInput): Promise<OperatorRetryResult> {
    if (input.reasonCode !== undefined && !OPERATOR_REASON_CODE_PATTERN.test(input.reasonCode)) {
      throw new TypeError("reasonCode must be a machine-readable code");
    }

    const operationId = crypto.randomUUID();

    try {
      return await this.database.withTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; version: number; quote_number: string | null; current_operation_id: string | null }>(
          `select status, version, quote_number, current_operation_id from quote_service.quotes where quote_id = $1 for update`,
          [input.quoteId]
        );
        const quote = rows[0];

        if (!quote) {
          return { kind: "QUOTE_NOT_FOUND" } as const;
        }

        const current = quote.current_operation_id
          ? (
              await client.query<{ status: string; snapshot_hash: string; snapshot_hash_algorithm: string }>(
                `select status, snapshot_hash, snapshot_hash_algorithm from quote_service.issuance_operations where operation_id = $1`,
                [quote.current_operation_id]
              )
            ).rows[0]
          : undefined;

        if (quote.status !== "issuing" || quote.current_operation_id !== input.failedOperationId || current?.status !== "failed") {
          return {
            kind: "INVALID_STATE",
            quoteStatus: quote.status,
            currentOperationId: quote.current_operation_id,
            currentOperationStatus: current?.status ?? null
          } as const;
        }

        // Same frozen snapshot: what is retried must still be what was accepted.
        const actual = issuedSnapshotHash(await loadIssuedSnapshot(client, input.quoteId));

        if (current.snapshot_hash_algorithm !== ISSUED_SNAPSHOT_HASH_ALGORITHM || actual !== current.snapshot_hash) {
          throw new SnapshotIntegrityError(input.failedOperationId, current.snapshot_hash, actual);
        }

        const { rows: inserted } = await client.query<{ deadline_at: Date; now: Date }>(
          `with clock as materialized (select ${DB_NOW} as now)
           insert into quote_service.issuance_operations (
             operation_id, quote_id, operation_type, origin, retry_of_operation_id, status, generation, attempt_count,
             next_attempt_at, accepted_at, deadline_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
           ) select $1, $2, 'quote.issue', 'operator_retry', $3, 'pending', 0, 0, k.now, k.now,
                    k.now + $4 * interval '1 millisecond', $5, $6, k.now, k.now
             from clock k
           returning deadline_at, accepted_at as now`,
          [operationId, input.quoteId, input.failedOperationId, this.config.deadlineMs, current.snapshot_hash, ISSUED_SNAPSHOT_HASH_ALGORITHM]
        );
        const { deadline_at: deadlineAt, now } = inserted[0]!;
        await client.query(
          `update quote_service.quotes set current_operation_id = $2, version = version + 1, updated_at = $3
           where quote_id = $1 and status = 'issuing'`,
          [input.quoteId, operationId, now]
        );
        await appendAudit(client, {
          quoteId: input.quoteId,
          type: "quote.issue.accepted",
          principalId: input.actorPrincipalId,
          operationId,
          correlationId: input.correlationId ?? null,
          keyHash: null,
          fromStatus: "issuing",
          toStatus: "issuing",
          data: {
            retryOf: input.failedOperationId,
            quoteNumber: quote.quote_number,
            previousVersion: quote.version,
            version: quote.version + 1,
            deadlineAt: deadlineAt.toISOString(),
            ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode })
          }
        });
        return { kind: "RETRY_CREATED", operationId, deadlineAt } as const;
      });
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }

      const { rows } = await this.database.query<{ deadline_at: Date }>(
        `select o.deadline_at from quote_service.quotes q
         join quote_service.issuance_operations o on o.operation_id = q.current_operation_id
         where q.quote_id = $1 and q.current_operation_id = $2`,
        [input.quoteId, operationId]
      );
      return rows[0] ? { kind: "RETRY_CREATED", operationId, deadlineAt: rows[0].deadline_at } : { kind: "NOT_APPLIED" };
    }
  }

  async loadVerifiedSnapshot(operationId: string): Promise<IssuedSnapshot> {
    // One consistent snapshot of quote, lines and shipping.
    return this.database.withTransaction(async (client) => {
      await client.query("set transaction isolation level repeatable read, read only");
      return (await loadVerifiedIssuedSnapshot(client, operationId)).snapshot;
    });
  }

  /** Quote row lock, then operation row lock (the global lock order); the clock is read once both are held. */
  private async lockOperation(client: PoolClient, operationId: string): Promise<{ quoteId: string; operation: OperationStateRow } | undefined> {
    // quote_id is immutable on an operation: reading it unlocked is safe.
    const { rows: owner } = await client.query<{ quote_id: string }>(
      `select quote_id from quote_service.issuance_operations where operation_id = $1`,
      [operationId]
    );

    if (!owner[0]) {
      return undefined;
    }

    await client.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [owner[0].quote_id]);
    const { rows } = await client.query<OperationStateRow>(
      `select status, generation::text as generation, lease_owner, lease_expires_at, deadline_at, next_attempt_at, attempt_count,
              ${DB_NOW} as now
       from quote_service.issuance_operations where operation_id = $1 for update`,
      [operationId]
    );
    return { quoteId: owner[0].quote_id, operation: rows[0]! };
  }

  /** Terminal `failed` at the deadline. `bumpGeneration` fences an expired holder (sweep); the holder's own failure needs no bump. */
  private async markDeadlineFailed(client: PoolClient, operationId: string, now: Date, bumpGeneration: boolean): Promise<number> {
    const { rows } = await client.query<{ generation: string }>(
      `update quote_service.issuance_operations
       set status = 'failed', generation = generation + $3, last_error_code = '${ISSUANCE_DEADLINE_EXCEEDED}',
           completed_at = $2, lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = $2
       where operation_id = $1 and status in ('pending', 'running')
       returning generation::text as generation`,
      [operationId, now, bumpGeneration ? 1 : 0]
    );
    return Number(rows[0]!.generation);
  }

  private async readState(queryable: Pick<Database, "query">, operationId: string): Promise<OperationStateRow | undefined> {
    const { rows } = await queryable.query<OperationStateRow>(
      `select status, generation::text as generation, lease_owner, lease_expires_at, deadline_at, next_attempt_at, attempt_count,
              ${DB_NOW} as now
       from quote_service.issuance_operations where operation_id = $1`,
      [operationId]
    );
    return rows[0];
  }
}
