import type { PoolClient, QueryResultRow } from "pg";

import { Quote } from "../../../domain";
import type { QuoteSnapshot, QuoteTimestampsState } from "../../../domain";
import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "../../../application/quote/errors";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompletionInput,
  PersistExistingQuoteInput,
  PersistNewQuoteInput,
  PersistRevisionInput,
  QuoteAuditEventRecord,
  QuoteAuditEventSnapshot,
  QuoteRepository,
  QuoteRepositoryTransaction
} from "../../../application/quote/ports/quote-repository";
import type { PostgresDatabase, SqlQueryable } from "./postgres";

interface QuoteRow extends QueryResultRow {
  quote_id: string;
  quote_number: string;
  opportunity_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  actor_type: QuoteSnapshot["actor"]["type"];
  actor_id: string;
  source_system: QuoteSnapshot["source"]["system"];
  source_correlation_id: string | null;
  status: QuoteSnapshot["status"];
  currency: QuoteSnapshot["currency"];
  customer_snapshot: QuoteSnapshot["customerSnapshot"];
  subtotal: string;
  tax_amount: string;
  total: string;
  valid_until: Date;
  version: number;
  revision_root_id: string;
  previous_revision_id: string | null;
  supersedes_quote_id: string | null;
  superseded_by_quote_id: string | null;
  issued_content_hash: string | null;
  issued_render_version: string | null;
  issued_pdf_storage_key: string | null;
  issued_pdf_sha256: string | null;
  issued_html_storage_key: string | null;
  issued_html_sha256: string | null;
  issued_document_generated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  issued_at: Date | null;
  accepted_at: Date | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  items: QuoteSnapshot["items"];
}

interface AuditEventRow extends QueryResultRow {
  audit_event_id: string;
  quote_id: string;
  quote_number: string;
  action: QuoteAuditEventSnapshot["action"];
  from_status: QuoteAuditEventSnapshot["fromStatus"];
  to_status: QuoteAuditEventSnapshot["toStatus"];
  actor_type: QuoteAuditEventSnapshot["actorType"];
  actor_id: string;
  source_system: QuoteAuditEventSnapshot["sourceSystem"];
  correlation_id: string | null;
  idempotency_key: string | null;
  event_at: Date;
  payload_snapshot: Record<string, unknown>;
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

function mapTimestamps(row: QuoteRow): QuoteTimestampsState {
  return {
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    issuedAt: toIsoString(row.issued_at),
    acceptedAt: toIsoString(row.accepted_at),
    paidAt: toIsoString(row.paid_at),
    cancelledAt: toIsoString(row.cancelled_at),
    expiredAt: toIsoString(row.expired_at)
  };
}

function mapQuoteSnapshot(row: QuoteRow): QuoteSnapshot {
  return {
    quoteId: row.quote_id,
    quoteNumber: row.quote_number,
    opportunityId: row.opportunity_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    actor: {
      type: row.actor_type,
      id: row.actor_id
    },
    source: {
      system: row.source_system,
      correlationId: row.source_correlation_id
    },
    status: row.status,
    currency: row.currency,
    customerSnapshot: row.customer_snapshot,
    items: row.items,
    pricing: {
      subtotal: row.subtotal,
      taxAmount: row.tax_amount,
      total: row.total
    },
    validUntil: row.valid_until.toISOString(),
    version: row.version,
    revisionRootId: row.revision_root_id,
    previousRevisionId: row.previous_revision_id,
    supersedesQuoteId: row.supersedes_quote_id,
    supersededByQuoteId: row.superseded_by_quote_id,
    issuedDocument:
      row.issued_content_hash && row.issued_render_version && row.issued_pdf_storage_key &&
      row.issued_pdf_sha256 && row.issued_html_storage_key && row.issued_html_sha256 &&
      row.issued_document_generated_at
        ? {
            contentHash: row.issued_content_hash,
            renderVersion: row.issued_render_version,
            pdfStorageKey: row.issued_pdf_storage_key,
            pdfSha256: row.issued_pdf_sha256,
            htmlStorageKey: row.issued_html_storage_key,
            htmlSha256: row.issued_html_sha256,
            generatedAt: row.issued_document_generated_at.toISOString()
          }
        : null,
    timestamps: mapTimestamps(row)
  };
}

async function fetchQuoteByWhere(
  queryable: SqlQueryable,
  predicateSql: string,
  value: string
): Promise<Quote | null> {
  const quoteResult = await queryable.query<QuoteRow>(
    `
      select
        q.quote_id,
        q.quote_number,
        q.opportunity_id,
        q.customer_id,
        q.conversation_id,
        q.actor_type,
        q.actor_id,
        q.source_system,
        q.source_correlation_id,
        q.status,
        q.currency,
        q.customer_snapshot,
        q.subtotal::text as subtotal,
        q.tax_amount::text as tax_amount,
        q.total::text as total,
        q.valid_until,
        q.version,
        q.revision_root_id,
        q.previous_revision_id,
        q.supersedes_quote_id,
        q.superseded_by_quote_id,
        q.issued_content_hash,
        q.issued_render_version,
        q.issued_pdf_storage_key,
        q.issued_pdf_sha256,
        q.issued_html_storage_key,
        q.issued_html_sha256,
        q.issued_document_generated_at,
        q.created_at,
        q.updated_at,
        q.issued_at,
        q.accepted_at,
        q.paid_at,
        q.cancelled_at,
        q.expired_at,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'lineId', ql.line_id::text,
              'type', ql.type,
              'externalItemId', ql.external_item_id,
              'sku', ql.sku,
              'description', ql.description,
              'quantity', ql.quantity::text,
              'unitPrice', ql.unit_price::text,
              'taxIncluded', ql.tax_included,
              'taxRate', ql.tax_rate::text,
              'lineSubtotal', ql.line_subtotal::text,
              'lineTax', ql.line_tax::text,
              'lineTotal', ql.line_total::text
            )
            order by ql.display_order asc
          ) filter (where ql.line_id is not null),
          '[]'::jsonb
        ) as items
      from quote_service.quotes q
      left join quote_service.quote_lines ql
        on ql.quote_id = q.quote_id
      where ${predicateSql}
      group by
        q.quote_id,
        q.quote_number,
        q.opportunity_id,
        q.customer_id,
        q.conversation_id,
        q.actor_type,
        q.actor_id,
        q.source_system,
        q.source_correlation_id,
        q.status,
        q.currency,
        q.customer_snapshot,
        q.subtotal,
        q.tax_amount,
        q.total,
        q.valid_until,
        q.version,
        q.revision_root_id,
        q.previous_revision_id,
        q.supersedes_quote_id,
        q.superseded_by_quote_id,
        q.issued_content_hash,
        q.issued_render_version,
        q.issued_pdf_storage_key,
        q.issued_pdf_sha256,
        q.issued_html_storage_key,
        q.issued_html_sha256,
        q.issued_document_generated_at,
        q.created_at,
        q.updated_at,
        q.issued_at,
        q.accepted_at,
        q.paid_at,
        q.cancelled_at,
        q.expired_at
    `,
    [value]
  );

  const quoteRow = quoteResult.rows[0];

  if (!quoteRow) {
    return null;
  }

  return Quote.rehydrate(mapQuoteSnapshot(quoteRow));
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

async function replaceQuoteLines(queryable: SqlQueryable, quote: Quote): Promise<void> {
  await queryable.query("delete from quote_service.quote_lines where quote_id = $1::uuid", [
    quote.quoteId
  ]);

  const snapshot = quote.toSnapshot();

  for (const [index, item] of snapshot.items.entries()) {
    await queryable.query(
      `
        insert into quote_service.quote_lines (
          line_id,
          quote_id,
          display_order,
          type,
          external_item_id,
          sku,
          description,
          quantity,
          unit_price,
          tax_included,
          tax_rate,
          line_subtotal,
          line_tax,
          line_total
        )
        values (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::numeric,
          $9::numeric,
          $10,
          $11::numeric,
          $12::numeric,
          $13::numeric,
          $14::numeric
        )
      `,
      [
        item.lineId,
        snapshot.quoteId,
        index,
        item.type,
        item.externalItemId,
        item.sku,
        item.description,
        item.quantity,
        item.unitPrice,
        item.taxIncluded,
        item.taxRate,
        item.lineSubtotal,
        item.lineTax,
        item.lineTotal
      ]
    );
  }
}

async function insertQuoteRow(queryable: SqlQueryable, quote: Quote): Promise<void> {
  const snapshot = quote.toSnapshot();

  await queryable.query(
    `
      insert into quote_service.quotes (
        quote_id,
        quote_number,
        opportunity_id,
        customer_id,
        conversation_id,
        actor_type,
        actor_id,
        source_system,
        source_correlation_id,
        status,
        currency,
        customer_snapshot,
        subtotal,
        tax_amount,
        total,
        valid_until,
        version,
        revision_root_id,
        previous_revision_id,
        supersedes_quote_id,
        superseded_by_quote_id,
        issued_content_hash,
        issued_render_version,
        issued_pdf_storage_key,
        issued_pdf_sha256,
        issued_html_storage_key,
        issued_html_sha256,
        issued_document_generated_at,
        created_at,
        updated_at,
        issued_at,
        accepted_at,
        paid_at,
        cancelled_at,
        expired_at
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
        $11,
        $12::jsonb,
        $13::numeric,
        $14::numeric,
        $15::numeric,
        $16::timestamptz,
        $17,
        $18::uuid,
        $19::uuid,
        $20::uuid,
        $21::uuid,
        $22,
        $23,
        $24,
        $25,
        $26,
        $27,
        $28::timestamptz,
        $29::timestamptz,
        $30::timestamptz,
        $31::timestamptz,
        $32::timestamptz,
        $33::timestamptz,
        $34::timestamptz,
        $35::timestamptz
      )
    `,
    [
      snapshot.quoteId,
      snapshot.quoteNumber,
      snapshot.opportunityId,
      snapshot.customerId,
      snapshot.conversationId,
      snapshot.actor.type,
      snapshot.actor.id,
      snapshot.source.system,
      snapshot.source.correlationId,
      snapshot.status,
      snapshot.currency,
      JSON.stringify(snapshot.customerSnapshot),
      snapshot.pricing.subtotal,
      snapshot.pricing.taxAmount,
      snapshot.pricing.total,
      snapshot.validUntil,
      snapshot.version,
      snapshot.revisionRootId,
      snapshot.previousRevisionId,
      snapshot.supersedesQuoteId,
      snapshot.supersededByQuoteId,
      snapshot.issuedDocument?.contentHash ?? null,
      snapshot.issuedDocument?.renderVersion ?? null,
      snapshot.issuedDocument?.pdfStorageKey ?? null,
      snapshot.issuedDocument?.pdfSha256 ?? null,
      snapshot.issuedDocument?.htmlStorageKey ?? null,
      snapshot.issuedDocument?.htmlSha256 ?? null,
      snapshot.issuedDocument?.generatedAt ?? null,
      snapshot.timestamps.createdAt,
      snapshot.timestamps.updatedAt,
      snapshot.timestamps.issuedAt,
      snapshot.timestamps.acceptedAt,
      snapshot.timestamps.paidAt,
      snapshot.timestamps.cancelledAt,
      snapshot.timestamps.expiredAt
    ]
  );
}

export class PostgresQuoteRepositoryTransaction implements QuoteRepositoryTransaction {
  constructor(private readonly client: PoolClient) {}

  async allocateNextQuoteNumber(): Promise<string> {
    const result = await this.client.query<{ quote_number: string }>(
      `
        select 'PC-' || lpad(nextval('quote_service.quote_number_seq')::text, 6, '0') as quote_number
      `
    );

    return result.rows[0]!.quote_number;
  }

  async findById(quoteId: string): Promise<Quote | null> {
    return fetchQuoteByWhere(this.client, "q.quote_id = $1::uuid", quoteId);
  }

  async findByQuoteNumber(quoteNumber: string): Promise<Quote | null> {
    return fetchQuoteByWhere(this.client, "q.quote_number = $1", quoteNumber);
  }

  async claimIdempotency(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const insertResult = await this.client.query(
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

    const existingResult = await this.client.query<IdempotencyRow>(
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

    throw new ApplicationError(
      APPLICATION_ERROR_CODES.idempotencyRequestInProgress,
      "Idempotent request is already in progress",
      {
        idempotencyKey: input.idempotencyKey,
        operationName: input.operationName
      }
    );
  }

  async persistNewQuote(input: PersistNewQuoteInput): Promise<void> {
    await insertQuoteRow(this.client, input.quote);
    await replaceQuoteLines(this.client, input.quote);
    await insertAuditEvents(this.client, input.auditEvents);
    await completeIdempotency(this.client, input.idempotencyCompletion);
  }

  async persistExistingQuote(input: PersistExistingQuoteInput): Promise<void> {
    const snapshot = input.quote.toSnapshot();
    const result = await this.client.query(
      `
        update quote_service.quotes
        set
          opportunity_id = $2,
          customer_id = $3,
          conversation_id = $4,
          actor_type = $5,
          actor_id = $6,
          source_system = $7,
          source_correlation_id = $8,
          status = $9,
          currency = $10,
          customer_snapshot = $11::jsonb,
          subtotal = $12::numeric,
          tax_amount = $13::numeric,
          total = $14::numeric,
          valid_until = $15::timestamptz,
          version = $16,
          revision_root_id = $17::uuid,
          previous_revision_id = $18::uuid,
          supersedes_quote_id = $19::uuid,
          superseded_by_quote_id = $20::uuid,
          issued_content_hash = $21,
          issued_render_version = $22,
          issued_pdf_storage_key = $23,
          issued_pdf_sha256 = $24,
          issued_html_storage_key = $25,
          issued_html_sha256 = $26,
          issued_document_generated_at = $27::timestamptz,
          created_at = $28::timestamptz,
          updated_at = $29::timestamptz,
          issued_at = $30::timestamptz,
          accepted_at = $31::timestamptz,
          paid_at = $32::timestamptz,
          cancelled_at = $33::timestamptz,
          expired_at = $34::timestamptz
        where quote_id = $1::uuid
          and version = $35
      `,
      [
        snapshot.quoteId,
        snapshot.opportunityId,
        snapshot.customerId,
        snapshot.conversationId,
        snapshot.actor.type,
        snapshot.actor.id,
        snapshot.source.system,
        snapshot.source.correlationId,
        snapshot.status,
        snapshot.currency,
        JSON.stringify(snapshot.customerSnapshot),
        snapshot.pricing.subtotal,
        snapshot.pricing.taxAmount,
        snapshot.pricing.total,
        snapshot.validUntil,
        snapshot.version,
        snapshot.revisionRootId,
        snapshot.previousRevisionId,
        snapshot.supersedesQuoteId,
        snapshot.supersededByQuoteId,
        snapshot.issuedDocument?.contentHash ?? null,
        snapshot.issuedDocument?.renderVersion ?? null,
        snapshot.issuedDocument?.pdfStorageKey ?? null,
        snapshot.issuedDocument?.pdfSha256 ?? null,
        snapshot.issuedDocument?.htmlStorageKey ?? null,
        snapshot.issuedDocument?.htmlSha256 ?? null,
        snapshot.issuedDocument?.generatedAt ?? null,
        snapshot.timestamps.createdAt,
        snapshot.timestamps.updatedAt,
        snapshot.timestamps.issuedAt,
        snapshot.timestamps.acceptedAt,
        snapshot.timestamps.paidAt,
        snapshot.timestamps.cancelledAt,
        snapshot.timestamps.expiredAt,
        input.expectedVersion
      ]
    );

    if (result.rowCount !== 1) {
      throw new ApplicationError(
        APPLICATION_ERROR_CODES.optimisticConcurrencyConflict,
        "Quote update lost the optimistic concurrency check",
        {
          quoteId: snapshot.quoteId,
          expectedVersion: input.expectedVersion
        }
      );
    }

    await replaceQuoteLines(this.client, input.quote);
    await insertAuditEvents(this.client, input.auditEvents);
    await completeIdempotency(this.client, input.idempotencyCompletion);
  }

  async persistRevisionAtomically(input: PersistRevisionInput): Promise<void> {
    try {
      await insertQuoteRow(this.client, input.revision);
      await replaceQuoteLines(this.client, input.revision);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          APPLICATION_ERROR_CODES.quoteAlreadySuperseded,
          "Predecessor quote is already superseded",
          {
            quoteId: input.predecessorLink.quoteId
          }
        );
      }

      throw error;
    }

    const updateResult = await this.client.query(
      `
        update quote_service.quotes
        set
          superseded_by_quote_id = $2::uuid,
          version = version + 1,
          updated_at = $3::timestamptz
        where quote_id = $1::uuid
          and version = $4
          and superseded_by_quote_id is null
      `,
      [
        input.predecessorLink.quoteId,
        input.predecessorLink.supersededByQuoteId,
        input.predecessorLink.updatedAt,
        input.predecessorExpectedVersion
      ]
    );

    if (updateResult.rowCount !== 1) {
      const current = await this.findById(input.predecessorLink.quoteId);

      if (!current) {
        throw new ApplicationError(
          APPLICATION_ERROR_CODES.quoteNotFound,
          "Predecessor quote not found",
          {
            quoteId: input.predecessorLink.quoteId
          }
        );
      }

      if (current.supersededByQuoteId !== null) {
        throw new ApplicationError(
          APPLICATION_ERROR_CODES.quoteAlreadySuperseded,
          "Predecessor quote is already superseded",
          {
            quoteId: input.predecessorLink.quoteId,
            supersededByQuoteId: current.supersededByQuoteId
          }
        );
      }

      throw new ApplicationError(
        APPLICATION_ERROR_CODES.optimisticConcurrencyConflict,
        "Revision lost the optimistic concurrency check",
        {
          quoteId: input.predecessorLink.quoteId,
          expectedVersion: input.predecessorExpectedVersion
        }
      );
    }

    await insertAuditEvents(this.client, input.auditEvents);
    await completeIdempotency(this.client, input.idempotencyCompletion);
  }
}

export class PostgresQuoteRepository implements QuoteRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async findById(quoteId: string): Promise<Quote | null> {
    return fetchQuoteByWhere(this.database, "q.quote_id = $1::uuid", quoteId);
  }

  async findByQuoteNumber(quoteNumber: string): Promise<Quote | null> {
    return fetchQuoteByWhere(this.database, "q.quote_number = $1", quoteNumber);
  }

  async listAuditEvents(quoteId: string): Promise<readonly QuoteAuditEventSnapshot[]> {
    const result = await this.database.query<AuditEventRow>(
      `
        select
          audit_event_id::text,
          quote_id::text,
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
        from quote_service.quote_audit_events
        where quote_id = $1::uuid
        order by event_at asc, audit_event_id asc
      `,
      [quoteId]
    );

    return result.rows.map((row) => ({
      auditEventId: row.audit_event_id,
      quoteId: row.quote_id,
      quoteNumber: row.quote_number,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorType: row.actor_type,
      actorId: row.actor_id,
      sourceSystem: row.source_system,
      correlationId: row.correlation_id,
      idempotencyKey: row.idempotency_key,
      eventAt: row.event_at.toISOString(),
      payloadSnapshot: row.payload_snapshot
    }));
  }

  async withTransaction<T>(
    work: (transaction: QuoteRepositoryTransaction) => Promise<T>
  ): Promise<T> {
    return this.database.withTransaction((client) =>
      work(new PostgresQuoteRepositoryTransaction(client))
    );
  }
}
