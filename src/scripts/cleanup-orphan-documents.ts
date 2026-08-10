import "dotenv/config";

import { loadEnv } from "../infrastructure/config/env";
import { DocumentReferenceCodec } from "../infrastructure/documents/document-reference";
import { QuoteDocumentAccessService } from "../infrastructure/documents/document-access-service";
import { FilesystemDocumentArtifactStorage } from "../infrastructure/documents/filesystem-document-artifact-storage";
import { PostgresDatabase } from "../infrastructure/persistence/postgres/postgres";

interface IssuedQuoteRow {
  quote_id: string;
  quote_number: string;
  opportunity_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  actor_type: "sales_agent" | "operator" | "system" | "service";
  actor_id: string;
  source_system: "crm_customer_360" | "manual" | "api" | "scheduler";
  source_correlation_id: string | null;
  currency: "CLP";
  customer_snapshot: {
    name: string;
    businessName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    district: string | null;
    region: string | null;
  };
  subtotal: string;
  tax_amount: string;
  total: string;
  valid_until: Date;
  version: number;
  revision_root_id: string;
  previous_revision_id: string | null;
  supersedes_quote_id: string | null;
  superseded_by_quote_id: string | null;
  issued_content_hash: string;
  issued_render_version: string;
  issued_pdf_storage_key: string;
  issued_pdf_sha256: string;
  issued_html_storage_key: string;
  issued_html_sha256: string;
  issued_document_generated_at: Date;
  created_at: Date;
  updated_at: Date;
  issued_at: Date | null;
  accepted_at: Date | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  items: Array<{
    lineId: string;
    type: "product" | "service";
    externalItemId: string | null;
    sku: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    taxIncluded: boolean;
    taxRate: string;
    lineSubtotal: string;
    lineTax: string;
    lineTotal: string;
  }>;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const database = new PostgresDatabase(env);
  const storage = new FilesystemDocumentArtifactStorage(env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const documentAccessService = new QuoteDocumentAccessService(
    storage,
    new DocumentReferenceCodec(env.QUOTE_DOCUMENT_REF_SECRET)
  );

  try {
    const result = await database.query<IssuedQuoteRow>(`
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
      where q.issued_content_hash is not null
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
    `);
    const liveStorageKeys = new Set<string>();

    for (const row of result.rows) {
      const liveKeys = documentAccessService.buildLiveStorageKeys({
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
        status: "issued",
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
        issuedDocument: {
          contentHash: row.issued_content_hash,
          renderVersion: row.issued_render_version,
          pdfStorageKey: row.issued_pdf_storage_key,
          pdfSha256: row.issued_pdf_sha256,
          htmlStorageKey: row.issued_html_storage_key,
          htmlSha256: row.issued_html_sha256,
          generatedAt: row.issued_document_generated_at.toISOString()
        },
        timestamps: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          issuedAt: row.issued_at?.toISOString() ?? null,
          acceptedAt: row.accepted_at?.toISOString() ?? null,
          paidAt: row.paid_at?.toISOString() ?? null,
          cancelledAt: row.cancelled_at?.toISOString() ?? null,
          expiredAt: row.expired_at?.toISOString() ?? null
        }
      });

      for (const storageKey of liveKeys) {
        liveStorageKeys.add(storageKey);
      }
    }

    const deletedCount = await documentAccessService.cleanupOrphanedArtifacts(liveStorageKeys);
    console.log(`Deleted ${deletedCount} orphaned document artifact(s).`);
  } finally {
    await database.close();
  }
}

void main();
