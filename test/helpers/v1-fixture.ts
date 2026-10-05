import crypto from "node:crypto";

import { runner } from "node-pg-migrate";
import pg from "pg";

import { MIGRATIONS_DIRECTORY } from "../../src/infrastructure/persistence/postgres/migrator";

/** Applies only the V1 migrations (000001-000005): a pre-R1.4 database. */
export async function migrateToV1Head(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIRECTORY,
    direction: "up",
    count: 5,
    migrationsTable: "schema_migrations",
    checkOrder: true,
    log: () => undefined
  });
}

// V1 line arithmetic (equivalent to the V2 normative arithmetic; the
// migration re-verifies it).
const S = 1_000_000n;
const scaled = (decimal: string) => {
  const [integer, fraction = ""] = decimal.split(".");
  return BigInt(integer!) * S + BigInt((fraction + "000000").slice(0, 6));
};
const halfUp = (numerator: bigint, denominator: bigint) => (2n * numerator + denominator) / (2n * denominator);

export function v1LineAmounts(unitPrice: number, quantity: string, taxIncluded: boolean, taxRate: string) {
  const extension = halfUp(BigInt(unitPrice) * scaled(quantity), S);
  const rate = scaled(taxRate);

  if (rate === 0n) {
    return { subtotal: extension, tax: 0n, total: extension };
  }

  if (taxIncluded) {
    const net = halfUp(extension * S, S + rate);
    return { subtotal: net, tax: extension - net, total: extension };
  }

  const tax = halfUp(extension * rate, S);
  return { subtotal: extension, tax, total: extension + tax };
}

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export const V1_IDS = {
  draft: "10000000-0000-4000-8000-000000000001",
  issued: "10000000-0000-4000-8000-000000000002",
  accepted: "10000000-0000-4000-8000-000000000003",
  paid: "10000000-0000-4000-8000-000000000004",
  cancelledIssued: "10000000-0000-4000-8000-000000000005",
  cancelledDraft: "10000000-0000-4000-8000-000000000006",
  expired: "10000000-0000-4000-8000-000000000007",
  revision: "10000000-0000-4000-8000-000000000008"
} as const;

export const V1_DELIVERIES = {
  sent: "20000000-0000-4000-8000-000000000001",
  pending: "20000000-0000-4000-8000-000000000002",
  processing: "20000000-0000-4000-8000-000000000003",
  failed: "20000000-0000-4000-8000-000000000004"
} as const;

export const V1_RAW_IDEMPOTENCY_KEYS = {
  createDraft: "v1-raw-key-create-draft-SECRET-1",
  issue: "v1-raw-key-issue-SECRET-2",
  sendEmail: "v1-raw-key-send-email-SECRET-3",
  inProgress: "v1-raw-key-in-progress-SECRET-4",
  failed: "v1-raw-key-failed-SECRET-5"
} as const;

/** Bytes of each issued V1 PDF, by quote id (for artifact verification). */
export const V1_PDF_BYTES: Record<string, Buffer> = {};

interface V1Line {
  readonly type: "product" | "service" | "shipping";
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: number;
  readonly taxIncluded: boolean;
  readonly taxRate: string;
  readonly externalSource?: string;
  readonly externalItemId?: string;
  readonly externalVariantId?: string;
  readonly sku?: string;
}

interface V1Quote {
  readonly id: string;
  readonly number: string;
  readonly status: "draft" | "issued" | "accepted" | "paid" | "cancelled" | "expired";
  readonly sourceSystem: "crm_customer_360" | "manual" | "api" | "scheduler";
  readonly opportunityId: string;
  readonly customerId?: string;
  readonly customer: Record<string, unknown>;
  readonly lines: readonly V1Line[];
  readonly issued: boolean;
  readonly validUntil: string;
  readonly acceptedAt?: string;
  readonly paidAt?: string;
  readonly cancelledAt?: string;
  readonly expiredAt?: string;
  readonly revisionRootId?: string;
  readonly previousRevisionId?: string;
  readonly supersedesQuoteId?: string;
  readonly version: number;
}

const ISSUED_AT = "2026-03-10T14:00:00.000Z";
const VALID_UNTIL = "2026-03-15T03:00:00.000Z";

const PRODUCT: V1Line = {
  type: "product",
  description: "Mancuerna hexagonal 10 kg",
  quantity: "2",
  unitPrice: 24990,
  taxIncluded: true,
  taxRate: "0.19",
  externalSource: "pesaschile-catalog",
  externalItemId: "1042",
  externalVariantId: "3317",
  sku: "MH-10"
};
const SERVICE_EXEMPT: V1Line = {
  type: "service",
  description: "Instalación (exenta)",
  quantity: "1",
  unitPrice: 35000,
  taxIncluded: false,
  taxRate: "0"
};
const SHIPPING: V1Line = {
  type: "shipping",
  description: "Despacho Starken a Ñuñoa",
  quantity: "1",
  unitPrice: 5990,
  taxIncluded: false,
  taxRate: "0.19"
};
const FRACTIONAL: V1Line = {
  type: "product",
  description: "Piso de goma 15 mm (m2)",
  quantity: "12.5",
  unitPrice: 18990,
  taxIncluded: true,
  taxRate: "0.19",
  sku: "PG-15"
};

export const V1_QUOTES: readonly V1Quote[] = [
  {
    id: V1_IDS.draft, number: "PC-000001", status: "draft", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-001", customerId: "cust-001",
    customer: { name: "Camila Rojas", email: "camila.rojas@example.com", phone: "+56 9 1234 5678" },
    lines: [PRODUCT, SERVICE_EXEMPT], issued: false, validUntil: VALID_UNTIL, version: 2
  },
  {
    id: V1_IDS.issued, number: "PC-000002", status: "issued", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-002", customerId: "cust-002",
    customer: {
      name: "Pedro Soto", businessName: "Gimnasio Andes SpA", email: "compras@andes.example.com",
      phone: "+56 2 2345 6789", address: "Av. Providencia 1234", district: "Providencia", region: "Región Metropolitana"
    },
    lines: [PRODUCT, SHIPPING, FRACTIONAL], issued: true, validUntil: VALID_UNTIL, version: 2
  },
  {
    id: V1_IDS.accepted, number: "PC-000003", status: "accepted", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-003",
    customer: { name: "Ana Díaz", email: "not-an-email", phone: "12" },
    lines: [PRODUCT], issued: true, validUntil: VALID_UNTIL, acceptedAt: "2026-03-11T10:00:00.000Z", version: 3
  },
  {
    id: V1_IDS.paid, number: "PC-000004", status: "paid", sourceSystem: "manual",
    opportunityId: "opp-manual-004",
    customer: { name: "Luis Pérez", district: "Ñuñoa" },
    lines: [SERVICE_EXEMPT, SHIPPING], issued: true, validUntil: VALID_UNTIL,
    acceptedAt: "2026-03-11T11:00:00.000Z", paidAt: "2026-03-12T09:00:00.000Z", version: 4
  },
  {
    id: V1_IDS.cancelledIssued, number: "PC-000005", status: "cancelled", sourceSystem: "api",
    opportunityId: "opp-api-005",
    customer: { name: "María González" },
    lines: [PRODUCT], issued: true, validUntil: VALID_UNTIL, cancelledAt: "2026-03-11T15:00:00.000Z", version: 3
  },
  {
    id: V1_IDS.cancelledDraft, number: "PC-000006", status: "cancelled", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-006",
    customer: { name: "Jorge Muñoz" },
    lines: [], issued: false, validUntil: VALID_UNTIL, cancelledAt: "2026-03-10T16:00:00.000Z", version: 2
  },
  {
    id: V1_IDS.expired, number: "PC-000007", status: "expired", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-007",
    customer: { name: "Sofía Torres", email: "sofia@example.com" },
    lines: [FRACTIONAL], issued: true, validUntil: VALID_UNTIL, expiredAt: "2026-03-15T03:00:05.000Z", version: 3
  },
  {
    id: V1_IDS.revision, number: "PC-000008", status: "draft", sourceSystem: "crm_customer_360",
    opportunityId: "opp-crm-002",
    customer: { name: "Pedro Soto", businessName: "Gimnasio Andes SpA" },
    lines: [PRODUCT], issued: false, validUntil: VALID_UNTIL,
    revisionRootId: V1_IDS.issued, previousRevisionId: V1_IDS.issued, supersedesQuoteId: V1_IDS.issued, version: 1
  }
];

export interface SeedOptions {
  /** Mutates the V1 rows before insert (to build invalid snapshots). */
  readonly overrideDescription?: { readonly quoteId: string; readonly description: string };
}

/** Seeds a representative V1 snapshot into a database at the V1 head. */
export async function seedV1Snapshot(databaseUrl: string, options: SeedOptions = {}): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    await client.query("select setval('quote_service.quote_number_seq', 8)");

    for (const quote of V1_QUOTES) {
      const lineAmounts = quote.lines.map((line) =>
        v1LineAmounts(line.unitPrice, line.quantity, line.taxIncluded, line.taxRate)
      );
      const subtotal = lineAmounts.reduce((sum, amounts) => sum + amounts.subtotal, 0n);
      const tax = lineAmounts.reduce((sum, amounts) => sum + amounts.tax, 0n);
      const total = lineAmounts.reduce((sum, amounts) => sum + amounts.total, 0n);
      const pdfBytes = Buffer.from(`%PDF-1.4 fixture ${quote.number}`);
      const pdfSha = quote.issued ? crypto.createHash("sha256").update(pdfBytes).digest("hex") : null;

      if (quote.issued) {
        V1_PDF_BYTES[quote.id] = pdfBytes;
      }

      await client.query(
        `insert into quote_service.quotes (
           quote_id, quote_number, opportunity_id, customer_id, conversation_id, actor_type, actor_id,
           source_system, source_correlation_id, status, currency, customer_snapshot, subtotal, tax_amount, total,
           valid_until, version, revision_root_id, previous_revision_id, supersedes_quote_id, superseded_by_quote_id,
           issued_content_hash, issued_render_version, issued_pdf_storage_key, issued_pdf_sha256,
           issued_html_storage_key, issued_html_sha256, issued_document_generated_at,
           created_at, updated_at, issued_at, accepted_at, paid_at, cancelled_at, expired_at
         ) values (
           $1, $2, $3, $4, $5, 'sales_agent', 'agent-7', $6, $7, $8, 'CLP', $9, $10, $11, $12,
           $13, $14, $15, $16, $17, null, $18, $19, $20, $21, $22, $23, $24,
           '2026-03-10T13:00:00Z', '2026-03-12T12:00:00Z', $25, $26, $27, $28, $29
         )`,
        [
          quote.id, quote.number, quote.opportunityId, quote.customerId ?? null, `conv-${quote.number}`,
          quote.sourceSystem, `corr-${quote.number}`, quote.status, JSON.stringify(quote.customer),
          subtotal.toString(), tax.toString(), total.toString(),
          quote.validUntil, quote.version, quote.revisionRootId ?? quote.id, quote.previousRevisionId ?? null,
          quote.supersedesQuoteId ?? null,
          quote.issued ? sha(`content:${quote.number}`) : null,
          quote.issued ? "quote-pdf-v3" : null,
          quote.issued ? `quotes/${quote.id}/${sha(`content:${quote.number}`)}/quote.pdf` : null,
          pdfSha,
          quote.issued ? `quotes/${quote.id}/${sha(`content:${quote.number}`)}/quote.html` : null,
          quote.issued ? sha(`html:${quote.number}`) : null,
          quote.issued ? "2026-03-10T14:00:01.000Z" : null,
          quote.issued ? ISSUED_AT : null,
          quote.acceptedAt ?? null, quote.paidAt ?? null, quote.cancelledAt ?? null, quote.expiredAt ?? null
        ]
      );

      for (const [index, line] of quote.lines.entries()) {
        const amounts = lineAmounts[index]!;
        const description =
          options.overrideDescription?.quoteId === quote.id && index === 0
            ? options.overrideDescription.description
            : line.description;

        await client.query(
          `insert into quote_service.quote_lines (
             line_id, quote_id, display_order, type, external_item_id, sku, description, quantity, unit_price,
             tax_included, tax_rate, line_subtotal, line_tax, line_total, external_source, external_variant_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            `30000000-0000-4000-8000-${quote.id.slice(-2)}${String(index + 1).padStart(10, "0")}`,
            quote.id, index, line.type, line.externalItemId ?? null, line.sku ?? null, description,
            line.quantity, line.unitPrice, line.taxIncluded, line.taxRate,
            amounts.subtotal.toString(), amounts.tax.toString(), amounts.total.toString(),
            line.externalSource ?? null, line.externalVariantId ?? null
          ]
        );
      }

      await client.query(
        `insert into quote_service.quote_audit_events (
           audit_event_id, quote_id, quote_number, action, from_status, to_status, actor_type, actor_id,
           source_system, correlation_id, idempotency_key, event_at, payload_snapshot
         ) values ($1, $2, $3, 'draft_created', null, 'draft', 'sales_agent', 'agent-7', $4, $5, $6,
                   '2026-03-10T13:00:00Z', $7)`,
        [
          `40000000-0000-4000-8000-${quote.id.slice(-2)}a000000000`, quote.id, quote.number, quote.sourceSystem,
          `corr-${quote.number}`,
          quote.id === V1_IDS.draft ? V1_RAW_IDEMPOTENCY_KEYS.createDraft : null,
          JSON.stringify({ customerSnapshot: quote.customer, note: "V1 payload snapshot with PII" })
        ]
      );

      if (quote.issued) {
        await client.query(
          `insert into quote_service.quote_audit_events (
             audit_event_id, quote_id, quote_number, action, from_status, to_status, actor_type, actor_id,
             source_system, correlation_id, idempotency_key, event_at, payload_snapshot
           ) values ($1, $2, $3, 'issued', 'draft', 'issued', 'sales_agent', 'agent-7', $4, $5, $6, $7, '{}')`,
          [
            `40000000-0000-4000-8000-${quote.id.slice(-2)}b000000000`, quote.id, quote.number, quote.sourceSystem,
            `corr-${quote.number}`,
            quote.id === V1_IDS.issued ? V1_RAW_IDEMPOTENCY_KEYS.issue : null,
            ISSUED_AT
          ]
        );
      }
    }

    // accepted quote has a V1 'accepted' audit event; the paid quote only has
    // 'paid', so its acceptance is derived from quotes.accepted_at.
    await client.query(
      `insert into quote_service.quote_audit_events (
         audit_event_id, quote_id, quote_number, action, from_status, to_status, actor_type, actor_id,
         source_system, correlation_id, idempotency_key, event_at, payload_snapshot
       ) values
       ('40000000-0000-4000-8000-0000000000c3', $1, 'PC-000003', 'accepted', 'issued', 'accepted', 'operator', 'op-1', 'crm_customer_360', null, null, '2026-03-11T10:00:00Z', '{}'),
       ('40000000-0000-4000-8000-0000000000d4', $2, 'PC-000004', 'paid', 'accepted', 'paid', 'operator', 'op-1', 'manual', null, null, '2026-03-12T09:00:00Z', '{}')`,
      [V1_IDS.accepted, V1_IDS.paid]
    );

    await client.query(
      `update quote_service.quotes set superseded_by_quote_id = $1 where quote_id = $2`,
      [V1_IDS.revision, V1_IDS.issued]
    );

    await client.query(
      `insert into quote_service.quote_deliveries (
         delivery_id, quote_id, channel, recipient, status, attempt_count, provider_message_id, failure_code,
         failure_message, actor_type, actor_id, source_system, source_correlation_id, created_at, processing_at,
         sent_at, failed_at, next_attempt_at
       ) values
       ($1, $5, 'email', 'compras@andes.example.com', 'sent', 1, 'gmail-msg-1', null, null, 'sales_agent', 'agent-7', 'crm_customer_360', null, '2026-03-10T14:05:00Z', '2026-03-10T14:05:01Z', '2026-03-10T14:05:02Z', null, null),
       ($2, $5, 'email', 'compras@andes.example.com', 'pending', 0, null, null, null, 'sales_agent', 'agent-7', 'crm_customer_360', null, '2026-03-12T10:00:00Z', null, null, null, '2026-03-12T10:00:00Z'),
       ($3, $6, 'email', 'sofia@example.com', 'processing', 1, null, null, null, 'sales_agent', 'agent-7', 'crm_customer_360', null, '2026-03-12T10:01:00Z', '2026-03-12T10:01:01Z', null, null, null),
       ($4, $6, 'email', 'sofia@example.com', 'failed', 5, null, 'Gmail-Rejected', 'provider said no', 'sales_agent', 'agent-7', 'crm_customer_360', null, '2026-03-12T10:02:00Z', '2026-03-12T10:02:01Z', null, '2026-03-12T10:30:00Z', null)`,
      [V1_DELIVERIES.sent, V1_DELIVERIES.pending, V1_DELIVERIES.processing, V1_DELIVERIES.failed, V1_IDS.issued, V1_IDS.expired]
    );

    await client.query(
      `insert into quote_service.quote_email_outbox (
         outbox_id, delivery_id, quote_id, status, attempt_count, next_attempt_at, created_at, updated_at
       ) values ('50000000-0000-4000-8000-000000000002', $1, $2, 'pending', 0, '2026-03-12T10:00:00Z', '2026-03-12T10:00:00Z', '2026-03-12T10:00:00Z')`,
      [V1_DELIVERIES.pending, V1_IDS.issued]
    );

    await client.query(
      `insert into quote_service.idempotency_keys (
         idempotency_key, operation_name, resource_type, resource_id, request_hash, status, response_code,
         response_body_snapshot, created_at, updated_at, expires_at
       ) values
       ($1, 'create_draft_quote', 'quote', $6, $9, 'completed', '201', '{"snapshot":"V1 response with PII"}', '2026-03-10T13:00:00Z', '2026-03-10T13:00:01Z', '2026-04-10T13:00:00Z'),
       ($2, 'issue_quote', 'quote', $7, $10, 'completed', '200', '{}', '2026-03-10T14:00:00Z', '2026-03-10T14:00:02Z', '2026-04-10T14:00:00Z'),
       ($3, 'send_quote_email', 'quote_delivery', $8, $11, 'completed', '202', '{}', '2026-03-10T14:05:00Z', '2026-03-10T14:05:00Z', '2026-04-10T14:05:00Z'),
       ($4, 'issue_quote', null, null, $12, 'in_progress', null, null, '2026-03-12T10:00:00Z', '2026-03-12T10:00:00Z', '2026-04-12T10:00:00Z'),
       ($5, 'cancel_quote', 'quote', null, $13, 'failed', null, null, '2026-03-12T10:00:00Z', '2026-03-12T10:00:00Z', '2026-04-12T10:00:00Z')`,
      [
        V1_RAW_IDEMPOTENCY_KEYS.createDraft, V1_RAW_IDEMPOTENCY_KEYS.issue, V1_RAW_IDEMPOTENCY_KEYS.sendEmail,
        V1_RAW_IDEMPOTENCY_KEYS.inProgress, V1_RAW_IDEMPOTENCY_KEYS.failed,
        V1_IDS.draft, V1_IDS.issued, V1_DELIVERIES.sent,
        sha("req:create"), sha("req:issue"), sha("req:email"), sha("req:inprogress"), sha("req:failed")
      ]
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export { sha as sha256Hex };
