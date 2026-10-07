import type { PoolClient } from "pg";

import type {
  AttemptOutcome,
  ClaimResult,
  CompletionResult,
  DeliveryContent,
  DeliveryFence,
  DeliveryQueueMetrics,
  DeliveryRepository,
  SweptDelivery
} from "../../../application/quote-v2/delivery/delivery-execution";
import { DELIVERY_ERROR_CODES, nextRetry } from "../../../application/quote-v2/delivery/delivery-policy";
import { effectiveExpiry } from "../../../application/quote-v2/expiry";
import { CommitOutcomeUnknownError, type PostgresDatabase } from "./postgres";
import { databaseClock, type QuoteClock } from "./quote-clock";
import { appendAudit } from "./quote-v2-acceptance";

/*
 * PostgreSQL delivery execution (R1.6B): claim, fenced completion, the
 * expired-`sending` sweep and queue metrics for `quote_deliveries`.
 *
 * LOCK ORDER (repository-wide): quote row, then delivery row. T8 cancel
 * locks the quote and then fails `pending` deliveries; `appendAudit` locks
 * the quote row too. Every transaction here therefore locks the quote FIRST:
 * the claim selects its candidate with `FOR UPDATE OF q SKIP LOCKED` (a quote
 * held by a cancel, a request or another worker is skipped, never waited
 * on), and completions and the sweep lock quote → delivery explicitly.
 *
 * NEVER RECLAIM: the claim selects only `pending` rows. An expired `sending`
 * lease is resolved exclusively by `sweepExpiredLeases` → `unknown` (terminal)
 * with a generation bump, because a provider call may have happened. There
 * is no code path `sending → sending` under another holder or
 * `sending (expired) → pending`.
 *
 * Time: every instant is the database clock read after the locks are held
 * (millisecond precision). Quote eligibility uses the injected QuoteClock
 * (the database clock in production), exactly like reads and cancel.
 */

const DB_NOW = `date_trunc('milliseconds', clock_timestamp())`;
const SYSTEM_PRINCIPAL = "system";

type Database = Pick<PostgresDatabase, "withTransaction" | "query">;

export interface DeliveryRepositoryConfig {
  readonly leaseMs: number;
  /** Expiry-projection clock (tests pin it); defaults to the database clock. */
  readonly clock?: QuoteClock | undefined;
}

interface DeliveryStateRow {
  delivery_id: string;
  quote_id: string;
  status: string;
  generation: string;
  lease_owner: string | null;
  attempt_count: number;
  requested_at: Date;
  next_attempt_at: Date | null;
  document_sha256: string;
  now: Date;
}

const fenceHolds = (row: DeliveryStateRow | undefined, fence: DeliveryFence): boolean =>
  row !== undefined && row.status === "sending" && Number(row.generation) === fence.generation && row.lease_owner === fence.leaseOwner;

const STATE_COLUMNS = `delivery_id, quote_id, status, generation::text as generation, lease_owner, attempt_count, requested_at,
       next_attempt_at, document_sha256, ${DB_NOW} as now`;

export class PostgresDeliveryRepository implements DeliveryRepository {
  readonly #clock: QuoteClock;

  constructor(
    private readonly database: Database,
    private readonly config: DeliveryRepositoryConfig
  ) {
    this.#clock = config.clock ?? databaseClock;
  }

  /**
   * One transaction: pick the oldest due `pending` delivery whose QUOTE row
   * can be locked now (`FOR UPDATE OF q SKIP LOCKED`), lock the delivery,
   * re-check it is still pending and due, then evaluate the quote's
   * effective status at that instant (A6.1):
   *   issued    → `sending`, generation + 1, lease, attempt + 1;
   *   expired   → `failed` (`quote_expired`), audit, provider never called;
   *   cancelled → `failed` (`quote_cancelled`), audit, provider never called;
   *   other     → `failed` (`quote_not_issued`), fail closed.
   * The quote itself is never written.
   */
  async claimNext(leaseOwner: string): Promise<ClaimResult> {
    try {
      return await this.database.withTransaction(async (client) => {
        const { rows: candidates } = await client.query<{ delivery_id: string }>(
          `select d.delivery_id
           from quote_service.quote_deliveries d
           join quote_service.quotes q on q.quote_id = d.quote_id
           where d.status = 'pending' and d.next_attempt_at <= ${DB_NOW}
           order by d.next_attempt_at, d.delivery_id
           limit 1
           for update of q skip locked`
        );
        const candidate = candidates[0];

        if (!candidate) {
          return { kind: "NONE_AVAILABLE" } as const;
        }

        const { rows } = await client.query<DeliveryStateRow>(
          `select ${STATE_COLUMNS} from quote_service.quote_deliveries where delivery_id = $1 for update`,
          [candidate.delivery_id]
        );
        const delivery = rows[0];

        if (!delivery || delivery.status !== "pending" || delivery.next_attempt_at === null || delivery.next_attempt_at > delivery.now) {
          return { kind: "NONE_AVAILABLE" } as const;
        }

        const { rows: quotes } = await client.query<{ status: string; valid_until_exclusive: Date | null; expired_at: Date | null }>(
          `select status, valid_until_exclusive, expired_at from quote_service.quotes where quote_id = $1`,
          [delivery.quote_id]
        );
        const quote = quotes[0]!;
        const effective = effectiveExpiry(
          { status: quote.status, validUntilExclusive: quote.valid_until_exclusive, expiredAt: quote.expired_at },
          await this.#clock.now(client)
        );

        if (effective.status !== "issued") {
          const errorCode =
            effective.status === "expired"
              ? DELIVERY_ERROR_CODES.quoteExpired
              : effective.status === "cancelled"
                ? DELIVERY_ERROR_CODES.quoteCancelled
                : DELIVERY_ERROR_CODES.quoteNotIssued;
          await client.query(
            `update quote_service.quote_deliveries
             set status = 'failed', last_error_code = $2, next_attempt_at = null, updated_at = $3
             where delivery_id = $1 and status = 'pending'`,
            [delivery.delivery_id, errorCode, delivery.now]
          );
          await this.#audit(client, "quote.delivery.failed", delivery, delivery.attempt_count, errorCode);
          return {
            kind: "FAILED_INELIGIBLE",
            deliveryId: delivery.delivery_id,
            quoteId: delivery.quote_id,
            errorCode,
            attemptCount: delivery.attempt_count
          } as const;
        }

        const { rows: claimed } = await client.query<{ generation: string; attempt_count: number; lease_expires_at: Date }>(
          `update quote_service.quote_deliveries
           set status = 'sending', generation = generation + 1, lease_owner = $2,
               lease_expires_at = $3::timestamptz + $4 * interval '1 millisecond',
               attempt_count = attempt_count + 1, last_attempt_at = $3, next_attempt_at = null, updated_at = $3
           where delivery_id = $1 and status = 'pending'
           returning generation::text as generation, attempt_count, lease_expires_at`,
          [delivery.delivery_id, leaseOwner, delivery.now, this.config.leaseMs]
        );
        const row = claimed[0]!;

        return {
          kind: "CLAIMED",
          delivery: {
            deliveryId: delivery.delivery_id,
            quoteId: delivery.quote_id,
            generation: Number(row.generation),
            leaseOwner,
            attemptCount: row.attempt_count,
            leaseExpiresAt: row.lease_expires_at,
            requestedAt: delivery.requested_at,
            documentSha256: delivery.document_sha256
          }
        } as const;
      });
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }

      // The lease owner is unique to this process and the worker has a single
      // slot: a `sending` row leased to us that we do not know about can only
      // be this claim. Adopting it is safe (no provider call has happened and
      // we hold its current generation); none means nothing was applied.
      const { rows } = await this.database.query<{
        delivery_id: string;
        quote_id: string;
        generation: string;
        attempt_count: number;
        lease_expires_at: Date;
        requested_at: Date;
        document_sha256: string;
      }>(
        `select delivery_id, quote_id, generation::text as generation, attempt_count, lease_expires_at, requested_at, document_sha256
         from quote_service.quote_deliveries
         where status = 'sending' and lease_owner = $1
         order by last_attempt_at desc limit 1`,
        [leaseOwner]
      );
      const adopted = rows[0];

      return adopted
        ? {
            kind: "CLAIMED",
            delivery: {
              deliveryId: adopted.delivery_id,
              quoteId: adopted.quote_id,
              generation: Number(adopted.generation),
              leaseOwner,
              attemptCount: adopted.attempt_count,
              leaseExpiresAt: adopted.lease_expires_at,
              requestedAt: adopted.requested_at,
              documentSha256: adopted.document_sha256
            }
          }
        : { kind: "NONE_AVAILABLE" };
    }
  }

  /** One read-only snapshot of the delivery's recipient snapshot, the frozen quote facts and the committed manifest. */
  async loadContent(deliveryId: string): Promise<DeliveryContent | null> {
    return this.database.withTransaction(async (client) => {
      await client.query("set transaction isolation level repeatable read, read only");
      const { rows } = await client.query<{
        recipient_email: string;
        recipient_name: string | null;
        quote_number: string | null;
        issue_local_date: string | null;
        document_id: string | null;
        manifest_quote_id: string | null;
        origin: "issuance" | "legacy_v1" | null;
        storage_key: string | null;
        pdf_sha256: string | null;
        byte_length: string | null;
      }>(
        `select d.recipient_email, d.recipient_name, q.quote_number, q.validity_issue_local_date::text as issue_local_date,
                m.document_id, m.quote_id as manifest_quote_id, m.origin, m.storage_key, m.pdf_sha256, m.byte_length::text as byte_length
         from quote_service.quote_deliveries d
         join quote_service.quotes q on q.quote_id = d.quote_id
         left join quote_service.quote_documents m on m.quote_id = d.quote_id
         where d.delivery_id = $1`,
        [deliveryId]
      );
      const row = rows[0];

      if (!row || row.quote_number === null || row.issue_local_date === null) {
        return null;
      }

      return {
        recipientEmail: row.recipient_email,
        recipientName: row.recipient_name,
        quoteNumber: row.quote_number,
        issueLocalDate: row.issue_local_date,
        manifest:
          row.document_id === null
            ? null
            : {
                documentId: row.document_id,
                quoteId: row.manifest_quote_id!,
                origin: row.origin!,
                storageKey: row.storage_key!,
                pdfSha256: row.pdf_sha256!,
                byteLength: row.byte_length === null ? null : Number(row.byte_length)
              }
      };
    });
  }

  /**
   * Fenced completion of the attempt `fence`, under quote → delivery locks.
   * Applies only while the row is still `sending` with our generation and
   * holder (a lease that merely expired, before any sweep, is still ours:
   * the outcome we report is the truth). Otherwise zero effect (STALE).
   *
   *   accepted                        → sent (sent_at, provider_message_id), audit sent
   *   not accepted, retry permitted   → pending (next_attempt_at), no audit
   *   not accepted, permanent/exhausted → failed (the failure's own code), audit failed
   *   ambiguous                       → unknown, audit unknown
   *
   * The quote is never written. A COMMIT whose outcome is unknown is
   * reconciled by reading the row; it is never replayed (and the provider is
   * never called again): if the row still shows our fence the lease expires
   * and the sweep records `unknown`.
   */
  async complete(fence: DeliveryFence, outcome: AttemptOutcome): Promise<CompletionResult> {
    let intended: CompletionResult["kind"] | null = null;

    try {
      return await this.database.withTransaction(async (client) => {
        const delivery = await this.#lockDelivery(client, fence.deliveryId);

        if (!fenceHolds(delivery, fence)) {
          return { kind: "STALE", currentStatus: delivery?.status ?? null } as const;
        }

        const row = delivery!;
        const fenced = `where delivery_id = $1 and generation = $2 and lease_owner = $3 and status = 'sending'`;
        const fenceValues = [fence.deliveryId, fence.generation, fence.leaseOwner];

        if (outcome.kind === "accepted") {
          intended = "SENT";
          await client.query(
            `update quote_service.quote_deliveries
             set status = 'sent', sent_at = $4, provider_message_id = $5, lease_owner = null, lease_expires_at = null,
                 next_attempt_at = null, updated_at = $4
             ${fenced}`,
            [...fenceValues, row.now, outcome.providerMessageId]
          );
          await this.#audit(client, "quote.delivery.sent", row, row.attempt_count, null);
          return { kind: "SENT" } as const;
        }

        if (outcome.kind === "ambiguous") {
          intended = "UNKNOWN";
          await client.query(
            `update quote_service.quote_deliveries
             set status = 'unknown', last_error_code = $4, lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = $5
             ${fenced}`,
            [...fenceValues, outcome.code, row.now]
          );
          await this.#audit(client, "quote.delivery.unknown", row, row.attempt_count, outcome.code);
          return { kind: "UNKNOWN" } as const;
        }

        const decision = outcome.retryable ? nextRetry({ attemptCount: row.attempt_count, requestedAt: row.requested_at, now: row.now }) : null;

        if (decision?.kind === "retry") {
          intended = "RESCHEDULED";
          await client.query(
            `update quote_service.quote_deliveries
             set status = 'pending', last_error_code = $4, next_attempt_at = $5, lease_owner = null, lease_expires_at = null, updated_at = $6
             ${fenced}`,
            [...fenceValues, outcome.code, decision.nextAttemptAt, row.now]
          );
          return { kind: "RESCHEDULED", nextAttemptAt: decision.nextAttemptAt } as const;
        }

        intended = "FAILED";
        await client.query(
          `update quote_service.quote_deliveries
           set status = 'failed', last_error_code = $4, lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = $5
           ${fenced}`,
          [...fenceValues, outcome.code, row.now]
        );
        await this.#audit(client, "quote.delivery.failed", row, row.attempt_count, outcome.code);
        return { kind: "FAILED", exhausted: outcome.retryable } as const;
      });
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        throw error;
      }

      const { rows } = await this.database.query<DeliveryStateRow>(
        `select ${STATE_COLUMNS} from quote_service.quote_deliveries where delivery_id = $1`,
        [fence.deliveryId]
      );
      const current = rows[0];

      if (fenceHolds(current, fence)) {
        return { kind: "NOT_APPLIED" };
      }

      if (current && Number(current.generation) === fence.generation && current.lease_owner === null) {
        const landed: Record<string, CompletionResult["kind"]> = { sent: "SENT", pending: "RESCHEDULED", failed: "FAILED", unknown: "UNKNOWN" };

        if (landed[current.status] === intended) {
          if (intended === "RESCHEDULED") {
            return { kind: "RESCHEDULED", nextAttemptAt: current.next_attempt_at! };
          }

          return intended === "FAILED" ? { kind: "FAILED", exhausted: outcome.kind === "not_accepted" && outcome.retryable } : ({ kind: intended });
        }
      }

      return { kind: "STALE", currentStatus: current?.status ?? null };
    }
  }

  /**
   * Expired `sending` leases → `unknown` (Idempotency §5, A6.3, D7): a
   * provider call may have happened, so the delivery is NEVER resent. Each
   * row in its own transaction under quote → delivery locks, re-checked
   * after locking: generation + 1 (fences the late holder), lease cleared,
   * `last_error_code = delivery_outcome_unknown`, one `quote.delivery.unknown`.
   * Persistence only (no provider, no storage). Idempotent: a terminal row is
   * never selected again, and a concurrent sweeper finds it no longer
   * `sending` after the lock.
   */
  async sweepExpiredLeases(limit: number): Promise<SweptDelivery[]> {
    const { rows: candidates } = await this.database.query<{ delivery_id: string }>(
      `select delivery_id from quote_service.quote_deliveries
       where status = 'sending' and lease_expires_at < ${DB_NOW}
       order by lease_expires_at, delivery_id
       limit $1`,
      [limit]
    );
    const swept: SweptDelivery[] = [];

    for (const { delivery_id: deliveryId } of candidates) {
      const result = await this.database.withTransaction(async (client) => {
        const delivery = await this.#lockDelivery(client, deliveryId);

        if (!delivery || delivery.status !== "sending") {
          return null;
        }

        const { rows } = await client.query<{ generation: string }>(
          `update quote_service.quote_deliveries
           set status = 'unknown', generation = generation + 1, lease_owner = null, lease_expires_at = null,
               last_error_code = '${DELIVERY_ERROR_CODES.outcomeUnknown}', next_attempt_at = null, updated_at = $2
           where delivery_id = $1 and status = 'sending' and lease_expires_at < $2
           returning generation::text as generation`,
          [deliveryId, delivery.now]
        );

        if (rows.length === 0) {
          return null;
        }

        await this.#audit(client, "quote.delivery.unknown", delivery, delivery.attempt_count, DELIVERY_ERROR_CODES.outcomeUnknown);
        return { deliveryId, quoteId: delivery.quote_id, generation: Number(rows[0]!.generation), attemptCount: delivery.attempt_count };
      });

      if (result) {
        swept.push(result);
      }
    }

    return swept;
  }

  /** emailDelivery worker metrics from durable state: due `pending` rows only. */
  async queueMetrics(): Promise<DeliveryQueueMetrics> {
    const { rows } = await this.database.query<{ depth: number; oldest: number | null }>(
      `with clock as materialized (select ${DB_NOW} as now)
       select count(d.delivery_id)::int as depth,
              floor(extract(epoch from (k.now - min(d.next_attempt_at))))::int as oldest
       from clock k
       left join quote_service.quote_deliveries d on d.status = 'pending' and d.next_attempt_at <= k.now
       group by k.now`
    );
    const row = rows[0]!;
    return { queueDepth: row.depth, oldestPendingAgeSeconds: row.oldest === null ? null : Math.max(0, row.oldest) };
  }

  /** Quote row lock, then delivery row lock (the global lock order); the clock is read once both are held. */
  async #lockDelivery(client: PoolClient, deliveryId: string): Promise<DeliveryStateRow | undefined> {
    // quote_id is immutable on a delivery: reading it unlocked is safe.
    const { rows: owner } = await client.query<{ quote_id: string }>(`select quote_id from quote_service.quote_deliveries where delivery_id = $1`, [deliveryId]);

    if (!owner[0]) {
      return undefined;
    }

    await client.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [owner[0].quote_id]);
    const { rows } = await client.query<DeliveryStateRow>(`select ${STATE_COLUMNS} from quote_service.quote_deliveries where delivery_id = $1 for update`, [deliveryId]);
    return rows[0];
  }

  /** Worker events: principal `system`, no operation, correlation or key; ids, hash, count and code only (never the recipient). */
  async #audit(client: PoolClient, type: string, delivery: DeliveryStateRow, attemptCount: number, errorCode: string | null): Promise<void> {
    await appendAudit(client, {
      quoteId: delivery.quote_id,
      type,
      principalId: SYSTEM_PRINCIPAL,
      operationId: null,
      correlationId: null,
      keyHash: null,
      fromStatus: null,
      toStatus: null,
      data: {
        deliveryId: delivery.delivery_id,
        documentSha256: delivery.document_sha256,
        attemptCount,
        ...(errorCode === null ? {} : { errorCode })
      }
    });
  }
}
