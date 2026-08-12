import type { PoolClient, QueryResultRow } from "pg";

import { QuoteDelivery } from "../../../domain";
import type { QuoteDeliveryState } from "../../../domain";
import type {
  QuoteDeliveryListInput,
  QuoteDeliveryListResult,
  QuoteDeliveryOutboxState,
  QuoteDeliveryQuoteDocumentRecord,
  QuoteDeliveryQuoteRecord,
  QuoteEmailDeliveryWorkItem,
  QuoteDeliveryRepository,
  QuoteDeliveryRepositoryTransaction
} from "../../../application/quote-delivery/ports/quote-delivery-repository";
import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "../../../application/quote/errors";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompletionInput,
  QuoteAuditEventRecord
} from "../../../application/quote/ports/quote-repository";
import type { PostgresDatabase, SqlQueryable } from "./postgres";

interface QuoteDeliveryRow extends QueryResultRow {
  delivery_id: string;
  quote_id: string;
  channel: QuoteDeliveryState["channel"];
  recipient: string;
  status: QuoteDeliveryState["status"];
  attempt_count: number;
  provider_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  actor_type: QuoteDeliveryState["actor"]["type"];
  actor_id: string;
  source_system: QuoteDeliveryState["source"]["system"];
  source_correlation_id: string | null;
  created_at: Date;
  processing_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  next_attempt_at: Date | null;
}

interface QuoteDeliveryQuoteRow extends QueryResultRow {
  quote_id: string;
  quote_number: string;
  status: QuoteDeliveryQuoteRecord["status"];
  customer_email: string | null;
  issued_content_hash: string | null;
  issued_render_version: string | null;
  issued_html_storage_key: string | null;
  issued_html_sha256: string | null;
  issued_pdf_storage_key: string | null;
  issued_pdf_sha256: string | null;
  issued_document_generated_at: Date | null;
}

interface ClaimedEmailDeliveryRow extends QueryResultRow {
  delivery_id: string;
  quote_id: string;
  channel: QuoteDeliveryState["channel"];
  recipient: string;
  status: QuoteDeliveryState["status"];
  attempt_count: number;
  provider_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  actor_type: QuoteDeliveryState["actor"]["type"];
  actor_id: string;
  source_system: QuoteDeliveryState["source"]["system"];
  source_correlation_id: string | null;
  created_at: Date;
  processing_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  next_attempt_at: Date | null;
  outbox_id: string;
  outbox_delivery_id: string;
  outbox_quote_id: string;
  outbox_status: QuoteDeliveryOutboxState["status"];
  outbox_attempt_count: number;
  outbox_next_attempt_at: Date;
  outbox_locked_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  outbox_created_at: Date;
  outbox_updated_at: Date;
  quote_number: string;
  quote_status: QuoteDeliveryQuoteRecord["status"];
  customer_email: string | null;
  issued_content_hash: string | null;
  issued_render_version: string | null;
  issued_html_storage_key: string | null;
  issued_html_sha256: string | null;
  issued_pdf_storage_key: string | null;
  issued_pdf_sha256: string | null;
  issued_document_generated_at: Date | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  response_code: string | null;
  response_body_snapshot: unknown;
}

function toIsoString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapDelivery(row: QuoteDeliveryRow): QuoteDeliveryState {
  return QuoteDelivery.rehydrate({
    deliveryId: row.delivery_id,
    quoteId: row.quote_id,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    attemptCount: row.attempt_count,
    providerMessageId: row.provider_message_id,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    actor: {
      type: row.actor_type,
      id: row.actor_id
    },
    source: {
      system: row.source_system,
      correlationId: row.source_correlation_id
    },
    createdAt: row.created_at.toISOString(),
    processingAt: toIsoString(row.processing_at),
    sentAt: toIsoString(row.sent_at),
    failedAt: toIsoString(row.failed_at),
    nextAttemptAt: toIsoString(row.next_attempt_at)
  }).toSnapshot();
}

function mapQuoteDocument(row: QuoteDeliveryQuoteRow): QuoteDeliveryQuoteDocumentRecord | null {
  if (
    !row.issued_content_hash ||
    !row.issued_render_version ||
    !row.issued_html_storage_key ||
    !row.issued_html_sha256 ||
    !row.issued_pdf_storage_key ||
    !row.issued_pdf_sha256 ||
    !row.issued_document_generated_at
  ) {
    return null;
  }

  return {
    contentHash: row.issued_content_hash,
    renderVersion: row.issued_render_version,
    htmlStorageKey: row.issued_html_storage_key,
    htmlSha256: row.issued_html_sha256,
    pdfStorageKey: row.issued_pdf_storage_key,
    pdfSha256: row.issued_pdf_sha256,
    generatedAt: row.issued_document_generated_at.toISOString()
  };
}

function mapQuoteRecord(row: QuoteDeliveryQuoteRow): QuoteDeliveryQuoteRecord {
  return {
    quoteId: row.quote_id,
    quoteNumber: row.quote_number,
    status: row.status,
    customerEmail: row.customer_email,
    issuedDocument: mapQuoteDocument(row)
  };
}

async function insertAuditEvents(
  queryable: SqlQueryable,
  auditEvents: readonly QuoteAuditEventRecord[]
): Promise<void> {
  for (const event of auditEvents) {
    await queryable.query(
      `
        insert into quote_service.quote_audit_events (
          quote_id,
          quote_number,
          action,
          from_status,
          to_status,
          actor_type,
          actor_id,
          source_system,
          correlation_id,
          idempotency_key,
          event_at,
          payload_snapshot
        )
        values (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::timestamptz,
          $12::jsonb
        )
      `,
      [
        event.quoteId,
        event.quoteNumber,
        event.action,
        event.fromStatus,
        event.toStatus,
        event.actorType,
        event.actorId,
        event.sourceSystem,
        event.correlationId,
        event.idempotencyKey,
        event.eventAt,
        JSON.stringify(event.payloadSnapshot)
      ]
    );
  }
}

async function completeIdempotency(
  queryable: SqlQueryable,
  completion: IdempotencyCompletionInput
): Promise<void> {
  const result = await queryable.query(
    `
      update quote_service.idempotency_keys
      set
        resource_type = $3,
        resource_id = $4::uuid,
        status = 'completed',
        response_code = $5,
        response_body_snapshot = $6::jsonb,
        updated_at = $7::timestamptz
      where idempotency_key = $1
        and operation_name = $2
        and status = 'in_progress'
    `,
    [
      completion.idempotencyKey,
      completion.operationName,
      completion.resourceType,
      completion.resourceId,
      completion.responseCode,
      JSON.stringify(completion.responseBodySnapshot),
      completion.completedAt
    ]
  );

  if (result.rowCount !== 1) {
    throw new Error("Unable to complete idempotency record");
  }
}

async function claimIdempotency(
  client: PoolClient,
  input: IdempotencyClaimInput
): Promise<IdempotencyClaimResult> {
  const insertResult = await client.query(
    `
      insert into quote_service.idempotency_keys (
        idempotency_key,
        operation_name,
        request_hash,
        status,
        created_at,
        updated_at,
        expires_at
      )
      values ($1, $2, $3, 'in_progress', now(), now(), $4::timestamptz)
      on conflict (idempotency_key, operation_name) do nothing
      returning idempotency_key
    `,
    [input.idempotencyKey, input.operationName, input.requestHash, input.expiresAt]
  );

  if (insertResult.rowCount === 1) {
    return {
      kind: "claimed"
    };
  }

  const existingResult = await client.query<IdempotencyRow>(
    `
      select
        request_hash,
        status,
        response_code,
        response_body_snapshot
      from quote_service.idempotency_keys
      where idempotency_key = $1
        and operation_name = $2
      for update
    `,
    [input.idempotencyKey, input.operationName]
  );
  const existing = existingResult.rows[0];

  if (!existing) {
    throw new Error("Idempotency row disappeared unexpectedly");
  }

  if (existing.request_hash !== input.requestHash) {
    throw new ApplicationError(
      APPLICATION_ERROR_CODES.idempotencyKeyReusedWithDifferentPayload,
      "Idempotency key was reused with a different payload",
      {
        idempotencyKey: input.idempotencyKey,
        operationName: input.operationName
      }
    );
  }

  if (existing.status === "completed") {
    return {
      kind: "replay",
      responseCode: existing.response_code ?? "completed",
      responseBodySnapshot: existing.response_body_snapshot
    };
  }

  if (existing.status === "failed") {
    const reclaimResult = await client.query(
      `
        update quote_service.idempotency_keys
        set
          status = 'in_progress',
          updated_at = now(),
          expires_at = $3::timestamptz,
          resource_type = null,
          resource_id = null,
          response_code = null,
          response_body_snapshot = null
        where idempotency_key = $1
          and operation_name = $2
          and request_hash = $4
          and status = 'failed'
      `,
      [input.idempotencyKey, input.operationName, input.expiresAt, input.requestHash]
    );

    if (reclaimResult.rowCount === 1) {
      return {
        kind: "claimed"
      };
    }
  }

  throw new ApplicationError(
    APPLICATION_ERROR_CODES.idempotencyRequestInProgress,
    "Idempotent request is already in progress",
    {
      idempotencyKey: input.idempotencyKey,
      operationName: input.operationName
    }
  );
}

async function fetchQuoteForDelivery(
  queryable: SqlQueryable,
  quoteId: string
): Promise<QuoteDeliveryQuoteRecord | null> {
  const result = await queryable.query<QuoteDeliveryQuoteRow>(
    `
      select
        q.quote_id::text,
        q.quote_number,
        q.status,
        q.customer_snapshot ->> 'email' as customer_email,
        q.issued_content_hash,
        q.issued_render_version,
        q.issued_html_storage_key,
        q.issued_html_sha256,
        q.issued_pdf_storage_key,
        q.issued_pdf_sha256,
        q.issued_document_generated_at
      from quote_service.quotes q
      where q.quote_id = $1::uuid
    `,
    [quoteId]
  );

  const row = result.rows[0];
  return row ? mapQuoteRecord(row) : null;
}

async function insertRequestedDelivery(
  queryable: SqlQueryable,
  input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
    readonly idempotencyCompletion: IdempotencyCompletionInput;
  }
): Promise<void> {
  await queryable.query(
    `
      insert into quote_service.quote_deliveries (
        delivery_id,
        quote_id,
        channel,
        recipient,
        status,
        attempt_count,
        provider_message_id,
        failure_code,
        failure_message,
        actor_type,
        actor_id,
        source_system,
        source_correlation_id,
        created_at,
        processing_at,
        sent_at,
        failed_at,
        next_attempt_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14::timestamptz,
        $15::timestamptz,
        $16::timestamptz,
        $17::timestamptz,
        $18::timestamptz
      )
    `,
    [
      input.delivery.deliveryId,
      input.delivery.quoteId,
      input.delivery.channel,
      input.delivery.recipient,
      input.delivery.status,
      input.delivery.attemptCount,
      input.delivery.providerMessageId,
      input.delivery.failureCode,
      input.delivery.failureMessage,
      input.delivery.actor.type,
      input.delivery.actor.id,
      input.delivery.source.system,
      input.delivery.source.correlationId,
      input.delivery.createdAt,
      input.delivery.processingAt,
      input.delivery.sentAt,
      input.delivery.failedAt,
      input.delivery.nextAttemptAt
    ]
  );
  await queryable.query(
    `
      insert into quote_service.quote_email_outbox (
        outbox_id,
        delivery_id,
        quote_id,
        status,
        attempt_count,
        next_attempt_at,
        locked_at,
        last_error_code,
        last_error_message,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4,
        $5,
        $6::timestamptz,
        $7::timestamptz,
        $8,
        $9,
        $10::timestamptz,
        $11::timestamptz
      )
    `,
    [
      input.outbox.outboxId,
      input.outbox.deliveryId,
      input.outbox.quoteId,
      input.outbox.status,
      input.outbox.attemptCount,
      input.outbox.nextAttemptAt,
      input.outbox.lockedAt,
      input.outbox.lastErrorCode,
      input.outbox.lastErrorMessage,
      input.outbox.createdAt,
      input.outbox.updatedAt
    ]
  );

  await insertAuditEvents(queryable, input.auditEvents);
  await completeIdempotency(queryable, input.idempotencyCompletion);
}

export class PostgresQuoteDeliveryRepositoryTransaction implements QuoteDeliveryRepositoryTransaction {
  constructor(private readonly client: PoolClient) {}

  async findQuoteForDelivery(quoteId: string): Promise<QuoteDeliveryQuoteRecord | null> {
    return fetchQuoteForDelivery(this.client, quoteId);
  }

  async claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    return claimIdempotency(this.client, input);
  }

  async persistRequestedDelivery(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
    readonly idempotencyCompletion: IdempotencyCompletionInput;
  }): Promise<void> {
    await insertRequestedDelivery(this.client, input);
  }
}

export class PostgresQuoteDeliveryRepository implements QuoteDeliveryRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async withTransaction<T>(
    work: (transaction: QuoteDeliveryRepositoryTransaction) => Promise<T>
  ): Promise<T> {
    return this.database.withTransaction((client) =>
      work(new PostgresQuoteDeliveryRepositoryTransaction(client))
    );
  }

  async listDeliveries(input: QuoteDeliveryListInput): Promise<QuoteDeliveryListResult> {
    const values: unknown[] = [input.quoteId];
    let whereSql = "where quote_id = $1::uuid";

    if (input.channel) {
      values.push(input.channel);
      whereSql += ` and channel = $${values.length}`;
    }

    values.push(input.limit);
    const limitParameter = `$${values.length}`;
    values.push(input.offset);
    const offsetParameter = `$${values.length}`;

    const result = await this.database.query<QuoteDeliveryRow>(
      `
        select
          delivery_id::text,
          quote_id::text,
          channel,
          recipient,
          status,
          attempt_count,
          provider_message_id,
          failure_code,
          failure_message,
          actor_type,
          actor_id,
          source_system,
          source_correlation_id,
          created_at,
          processing_at,
          sent_at,
          failed_at,
          next_attempt_at
        from quote_service.quote_deliveries
        ${whereSql}
        order by created_at desc, delivery_id desc
        limit ${limitParameter}
        offset ${offsetParameter}
      `,
      values
    );

    return {
      items: result.rows.map(mapDelivery),
      pagination: {
        limit: input.limit,
        offset: input.offset,
        count: result.rows.length
      }
    };
  }

  async findDelivery(quoteId: string, deliveryId: string): Promise<QuoteDeliveryState | null> {
    const result = await this.database.query<QuoteDeliveryRow>(
      `
        select
          delivery_id::text,
          quote_id::text,
          channel,
          recipient,
          status,
          attempt_count,
          provider_message_id,
          failure_code,
          failure_message,
          actor_type,
          actor_id,
          source_system,
          source_correlation_id,
          created_at,
          processing_at,
          sent_at,
          failed_at,
          next_attempt_at
        from quote_service.quote_deliveries
        where quote_id = $1::uuid
          and delivery_id = $2::uuid
      `,
      [quoteId, deliveryId]
    );
    const row = result.rows[0];

    return row ? mapDelivery(row) : null;
  }

  async claimPendingEmailDeliveries(input: {
    readonly now: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly QuoteEmailDeliveryWorkItem[]> {
    return this.database.withTransaction(async (client) => {
      const staleThreshold = new Date(Date.parse(input.now) - input.leaseMs).toISOString();
      const candidateResult = await client.query<ClaimedEmailDeliveryRow>(
        `
          with candidates as (
            select
              o.outbox_id,
              o.delivery_id,
              o.quote_id,
              o.status as outbox_status,
              o.attempt_count as outbox_attempt_count,
              o.next_attempt_at as outbox_next_attempt_at,
              o.locked_at as outbox_locked_at,
              o.last_error_code,
              o.last_error_message,
              o.created_at as outbox_created_at,
              o.updated_at as outbox_updated_at
            from quote_service.quote_email_outbox o
            where
              (
                o.status = 'pending'
                and o.next_attempt_at <= $1::timestamptz
              )
              or (
                o.status = 'processing'
                and o.locked_at is not null
                and o.locked_at <= $2::timestamptz
              )
            order by o.next_attempt_at asc, o.created_at asc, o.outbox_id asc
            limit $3
            for update skip locked
          ),
          updated_outbox as (
            update quote_service.quote_email_outbox o
            set
              status = 'processing',
              attempt_count = o.attempt_count + 1,
              locked_at = $1::timestamptz,
              updated_at = $1::timestamptz
            from candidates c
            where o.outbox_id = c.outbox_id
            returning
              o.outbox_id::text,
              o.delivery_id::text,
              o.quote_id::text,
              o.status as outbox_status,
              o.attempt_count as outbox_attempt_count,
              o.next_attempt_at as outbox_next_attempt_at,
              o.locked_at as outbox_locked_at,
              o.last_error_code,
              o.last_error_message,
              o.created_at as outbox_created_at,
              o.updated_at as outbox_updated_at
          ),
          updated_delivery as (
            update quote_service.quote_deliveries d
            set
              status = 'processing',
              attempt_count = d.attempt_count + 1,
              provider_message_id = null,
              failure_code = null,
              failure_message = null,
              processing_at = $1::timestamptz,
              failed_at = null,
              next_attempt_at = null
            from updated_outbox u
            where d.delivery_id = u.delivery_id::uuid
            returning
              d.delivery_id::text,
              d.quote_id::text,
              d.channel,
              d.recipient,
              d.status,
              d.attempt_count,
              d.provider_message_id,
              d.failure_code,
              d.failure_message,
              d.actor_type,
              d.actor_id,
              d.source_system,
              d.source_correlation_id,
              d.created_at,
              d.processing_at,
              d.sent_at,
              d.failed_at,
              d.next_attempt_at
          )
          select
            d.delivery_id,
            d.quote_id,
            d.channel,
            d.recipient,
            d.status,
            d.attempt_count,
            d.provider_message_id,
            d.failure_code,
            d.failure_message,
            d.actor_type,
            d.actor_id,
            d.source_system,
            d.source_correlation_id,
            d.created_at,
            d.processing_at,
            d.sent_at,
            d.failed_at,
            d.next_attempt_at,
            o.outbox_id,
            o.delivery_id as outbox_delivery_id,
            o.quote_id as outbox_quote_id,
            o.outbox_status,
            o.outbox_attempt_count,
            o.outbox_next_attempt_at,
            o.outbox_locked_at,
            o.last_error_code,
            o.last_error_message,
            o.outbox_created_at,
            o.outbox_updated_at,
            q.quote_number,
            q.status as quote_status,
            q.customer_snapshot ->> 'email' as customer_email,
            q.issued_content_hash,
            q.issued_render_version,
            q.issued_html_storage_key,
            q.issued_html_sha256,
            q.issued_pdf_storage_key,
            q.issued_pdf_sha256,
            q.issued_document_generated_at
          from updated_delivery d
          join updated_outbox o
            on o.delivery_id = d.delivery_id
          join quote_service.quotes q
            on q.quote_id = d.quote_id::uuid
          order by o.outbox_next_attempt_at asc, o.outbox_created_at asc, o.outbox_id asc
        `,
        [input.now, staleThreshold, input.limit]
      );

      return candidateResult.rows.map((row) => ({
        delivery: mapDelivery({
          delivery_id: row.delivery_id,
          quote_id: row.quote_id,
          channel: row.channel,
          recipient: row.recipient,
          status: row.status,
          attempt_count: row.attempt_count,
          provider_message_id: row.provider_message_id,
          failure_code: row.failure_code,
          failure_message: row.failure_message,
          actor_type: row.actor_type,
          actor_id: row.actor_id,
          source_system: row.source_system,
          source_correlation_id: row.source_correlation_id,
          created_at: row.created_at,
          processing_at: row.processing_at,
          sent_at: row.sent_at,
          failed_at: row.failed_at,
          next_attempt_at: row.next_attempt_at
        }),
        outbox: {
          outboxId: row.outbox_id,
          deliveryId: row.outbox_delivery_id,
          quoteId: row.outbox_quote_id,
          status: row.outbox_status,
          attemptCount: row.outbox_attempt_count,
          nextAttemptAt: row.outbox_next_attempt_at.toISOString(),
          lockedAt: toIsoString(row.outbox_locked_at),
          lastErrorCode: row.last_error_code,
          lastErrorMessage: row.last_error_message,
          createdAt: row.outbox_created_at.toISOString(),
          updatedAt: row.outbox_updated_at.toISOString()
        },
        quote: mapQuoteRecord({
          quote_id: row.quote_id,
          quote_number: row.quote_number,
          status: row.quote_status,
          customer_email: row.customer_email,
          issued_content_hash: row.issued_content_hash,
          issued_render_version: row.issued_render_version,
          issued_html_storage_key: row.issued_html_storage_key,
          issued_html_sha256: row.issued_html_sha256,
          issued_pdf_storage_key: row.issued_pdf_storage_key,
          issued_pdf_sha256: row.issued_pdf_sha256,
          issued_document_generated_at: row.issued_document_generated_at
        })
      }));
    });
  }

  async markDeliverySent(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly sentAt: string;
    readonly providerMessageId?: string | null;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
  }): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const sentDelivery = QuoteDelivery.rehydrate(input.delivery)
        .markSent({
          sentAt: input.sentAt,
          ...(input.providerMessageId !== undefined
            ? { providerMessageId: input.providerMessageId }
            : {})
        })
        .toSnapshot();

      await client.query(
        `
          update quote_service.quote_deliveries
          set
            status = $3,
            attempt_count = $4,
            provider_message_id = $5,
            failure_code = $6,
            failure_message = $7,
            processing_at = $8::timestamptz,
            sent_at = $9::timestamptz,
            failed_at = $10::timestamptz,
            next_attempt_at = $11::timestamptz
          where delivery_id = $1::uuid
            and quote_id = $2::uuid
        `,
        [
          sentDelivery.deliveryId,
          sentDelivery.quoteId,
          sentDelivery.status,
          sentDelivery.attemptCount,
          sentDelivery.providerMessageId,
          sentDelivery.failureCode,
          sentDelivery.failureMessage,
          sentDelivery.processingAt,
          sentDelivery.sentAt,
          sentDelivery.failedAt,
          sentDelivery.nextAttemptAt
        ]
      );
      await client.query(
        `
          update quote_service.quote_email_outbox
          set
            status = 'completed',
            locked_at = null,
            last_error_code = null,
            last_error_message = null,
            updated_at = $2::timestamptz
          where outbox_id = $1::uuid
        `,
        [input.outbox.outboxId, input.sentAt]
      );
      await insertAuditEvents(client, input.auditEvents);
    });
  }

  async markDeliveryFailed(input: {
    readonly delivery: QuoteDeliveryState;
    readonly outbox: QuoteDeliveryOutboxState;
    readonly failedAt: string;
    readonly failureCode: string;
    readonly failureMessage: string;
    readonly retryScheduled: boolean;
    readonly nextAttemptAt: string | null;
    readonly auditEvents: readonly QuoteAuditEventRecord[];
  }): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const failedDelivery = QuoteDelivery.rehydrate(input.delivery)
        .markFailed({
          failedAt: input.failedAt,
          failureCode: input.failureCode,
          failureMessage: input.failureMessage,
          nextAttemptAt: input.nextAttemptAt
        })
        .toSnapshot();

      await client.query(
        `
          update quote_service.quote_deliveries
          set
            status = $3,
            attempt_count = $4,
            provider_message_id = $5,
            failure_code = $6,
            failure_message = $7,
            processing_at = $8::timestamptz,
            sent_at = $9::timestamptz,
            failed_at = $10::timestamptz,
            next_attempt_at = $11::timestamptz
          where delivery_id = $1::uuid
            and quote_id = $2::uuid
        `,
        [
          failedDelivery.deliveryId,
          failedDelivery.quoteId,
          failedDelivery.status,
          failedDelivery.attemptCount,
          failedDelivery.providerMessageId,
          failedDelivery.failureCode,
          failedDelivery.failureMessage,
          failedDelivery.processingAt,
          failedDelivery.sentAt,
          failedDelivery.failedAt,
          failedDelivery.nextAttemptAt
        ]
      );
      await client.query(
        `
          update quote_service.quote_email_outbox
          set
            status = $2,
            locked_at = null,
            last_error_code = $3,
            last_error_message = $4,
            next_attempt_at = $5::timestamptz,
            updated_at = $6::timestamptz
          where outbox_id = $1::uuid
        `,
        [
          input.outbox.outboxId,
          input.retryScheduled ? "pending" : "failed",
          input.failureCode,
          input.failureMessage,
          input.nextAttemptAt ?? input.failedAt,
          input.failedAt
        ]
      );
      await insertAuditEvents(client, input.auditEvents);
    });
  }
}
