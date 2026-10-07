import crypto from "node:crypto";

import type { PoolClient } from "pg";

import { hasScope, type AuthenticatedPrincipal } from "../../../application/auth/principal";
import { idempotencyScope, type IdempotentOperation } from "../../../application/idempotency/idempotency-scope";
import { canonicalDecimal } from "../../../application/quote-v2/arithmetic";
import type { CommittedArtifactManifest } from "../../../application/quote-v2/document/artifact-store-port";
import { QuoteRequestRejected } from "../../../application/quote-v2/create-quote-request";
import { effectiveExpiry, effectiveStatusSql } from "../../../application/quote-v2/expiry";
import { formatInstant } from "../../../application/quote-v2/validity";
import { PostgresIdempotencyBindingStore } from "./idempotency-binding-store";
import type { PostgresDatabase } from "./postgres";
import { databaseClock, type QuoteClock } from "./quote-clock";

/*
 * Owner read surface (R1.5A.4): contract `Quote`, `Operation`, `QuotePage`,
 * `AuditPage` and `IdempotencyLookup` representations.
 *
 * Visibility (security §3) is enforced in SQL: a principal without
 * `quotes:read:any` only ever selects rows it created, and a non-visible row
 * is indistinguishable from a missing one (404). Every public status is the
 * effective one (expiry projection, application/quote-v2/expiry.ts) computed
 * from the injected clock. No internal column (storage keys, lease/fencing,
 * legacy evidence, override note, request snapshots) is ever selected into a
 * response.
 */

export type Json = Record<string, unknown>;
export type QuoteView = Json & { readonly quoteId: string; readonly status: string; readonly version: number };
export type OperationView = Json & { readonly operationId: string; readonly status: string };

interface AmountColumns {
  net_amount: string;
  tax_amount: string;
  gross_amount: string;
}

interface ChargeColumns extends AmountColumns {
  unit: string;
  tax_basis: string;
  tax_rate: string | null;
}

export interface QuoteRow extends AmountColumns {
  quote_id: string;
  status: string;
  version: number;
  quote_number: string | null;
  currency: string;
  source_system: string;
  external_reference_type: string | null;
  external_reference: string | null;
  customer: Json;
  exempt_net_amount: string;
  issued_at: Date | null;
  issuer_profile_id: string | null;
  current_operation_id: string | null;
  validity_source: string | null;
  validity_policy_id: string | null;
  validity_issuer_zone: string | null;
  validity_tzdb_version: string | null;
  issue_local_date: string | null;
  through_local_date: string | null;
  valid_until_exclusive: Date | null;
  validity_override_principal_id: string | null;
  validity_override_reason_code: string | null;
  cancelled_at: Date | null;
  cancellation_reason_code: string | null;
  cancellation_initiated_by: string | null;
  expired_at: Date | null;
  created_by_principal_id: string;
  created_at: Date;
  updated_at: Date;
}

interface LineRow extends ChargeColumns {
  quote_id: string;
  line_id: string;
  position: number;
  kind: string;
  item_source_system: string;
  item_product_ref: string | null;
  item_variant_ref: string | null;
  item_sku: string | null;
  item_description: string;
  item_attributes: unknown[];
  quantity: string;
  quantity_unit: string;
  pricing_source_system: string | null;
  pricing_reference: string | null;
  pricing_as_of: Date | null;
}

interface ShippingRow extends ChargeColumns {
  quote_id: string;
  carrier_code: string | null;
  carrier_name: string;
  service_type_code: string | null;
  service_type_name: string | null;
  destination_commune: string;
  destination_region: string | null;
  destination_country: string;
  source_quote_system: string | null;
  source_quote_reference: string | null;
  source_quote_as_of: Date | null;
}

/** Public manifest columns only: never `storage_key` or `origin`. */
interface DocumentRow {
  quote_id: string;
  content_type: string;
  semantic_snapshot_hash: string;
  pdf_sha256: string;
  byte_length: string | null;
  renderer_version: string;
  template_version: string;
  generated_at: Date;
  artifact_ref: string;
}

interface OperationRow {
  operation_id: string;
  operation_type: string;
  status: string;
  quote_id: string;
  accepted_at: Date;
  deadline_at: Date;
  completed_at: Date | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  next_attempt_at: Date | null;
}

interface AuditRow {
  event_id: string;
  sequence: number;
  event_type: string;
  occurred_at: Date;
  principal_id: string;
  operation_id: string | null;
  correlation_id: string | null;
  idempotency_key_hash: string | null;
  from_status: string | null;
  to_status: string | null;
  data: Json;
}

/** Quote columns plus civil dates as text (a `date` must never pass through a JS Date). */
export const QUOTE_COLUMNS = `q.*, q.validity_issue_local_date::text as issue_local_date,
       q.validity_through_local_date::text as through_local_date`;

export const omitNull = (object: Json): Json =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

const amountsView = (row: AmountColumns) => ({
  net: Number(row.net_amount),
  tax: Number(row.tax_amount),
  gross: Number(row.gross_amount)
});

const chargeView = (row: ChargeColumns) =>
  omitNull({ amount: Number(row.unit), taxBasis: row.tax_basis, taxRate: row.tax_rate === null ? null : canonicalDecimal(row.tax_rate) });

export const iso = (value: Date | null): string | null => (value === null ? null : formatInstant(value));

const lineView = (line: LineRow): Json =>
  omitNull({
    lineId: line.line_id,
    position: line.position,
    kind: line.kind,
    item: omitNull({
      sourceSystem: line.item_source_system,
      productRef: line.item_product_ref,
      variantRef: line.item_variant_ref,
      sku: line.item_sku,
      description: line.item_description,
      attributes: line.item_attributes.length > 0 ? line.item_attributes : null
    }),
    quantity: { value: canonicalDecimal(line.quantity), unit: line.quantity_unit },
    unitPrice: chargeView(line),
    pricingProvenance:
      line.pricing_source_system === null
        ? null
        : omitNull({ sourceSystem: line.pricing_source_system, reference: line.pricing_reference, asOf: iso(line.pricing_as_of) }),
    amounts: amountsView(line)
  });

const shippingView = (s: ShippingRow): Json =>
  omitNull({
    carrier: omitNull({ code: s.carrier_code, name: s.carrier_name }),
    serviceType:
      s.service_type_code === null && s.service_type_name === null ? null : omitNull({ code: s.service_type_code, name: s.service_type_name }),
    destination: omitNull({ commune: s.destination_commune, region: s.destination_region, country: s.destination_country }),
    amount: chargeView(s),
    sourceQuote:
      s.source_quote_system === null
        ? null
        : omitNull({ sourceSystem: s.source_quote_system, reference: s.source_quote_reference, asOf: iso(s.source_quote_as_of) }),
    amounts: amountsView(s)
  });

/** Contract `Document`: every member but `available`/`contentType` is null until the manifest commits. */
const documentView = (d: DocumentRow | undefined): Json =>
  d
    ? {
        available: true,
        contentType: d.content_type,
        semanticSnapshotHash: d.semantic_snapshot_hash,
        pdfSha256: d.pdf_sha256,
        // Unknown for a legacy V1 artifact until verified from its stored bytes.
        byteLength: d.byte_length === null ? null : Number(d.byte_length),
        rendererVersion: d.renderer_version,
        templateVersion: d.template_version,
        generatedAt: iso(d.generated_at),
        artifactRef: d.artifact_ref
      }
    : {
        available: false,
        contentType: "application/pdf",
        semanticSnapshotHash: null,
        pdfSha256: null,
        byteLength: null,
        rendererVersion: null,
        templateVersion: null,
        generatedAt: null,
        artifactRef: null
      };

function quoteView(q: QuoteRow, lines: readonly LineRow[], shipping: ShippingRow | undefined, document: DocumentRow | undefined, now: Date): QuoteView {
  const effective = effectiveExpiry({ status: q.status, validUntilExclusive: q.valid_until_exclusive, expiredAt: q.expired_at }, now);

  return {
    quoteId: q.quote_id,
    status: effective.status,
    version: q.version,
    quoteNumber: q.quote_number,
    currency: q.currency,
    externalCorrelation: omitNull({
      sourceSystem: q.source_system,
      externalReferenceType: q.external_reference_type,
      externalReference: q.external_reference
    }),
    customer: q.customer,
    lines: lines.map(lineView),
    shipping: shipping ? shippingView(shipping) : null,
    totals: { ...amountsView(q), exemptNet: Number(q.exempt_net_amount) },
    validity:
      q.validity_source === null
        ? null
        : {
            source: q.validity_source,
            policyId: q.validity_policy_id,
            issuerZone: q.validity_issuer_zone,
            tzdbVersion: q.validity_tzdb_version,
            issueLocalDate: q.issue_local_date,
            validThroughLocalDate: q.through_local_date,
            validUntilExclusive: iso(q.valid_until_exclusive),
            override:
              q.validity_override_principal_id === null
                ? null
                : { principalId: q.validity_override_principal_id, reasonCode: q.validity_override_reason_code }
          },
    issuance:
      q.issued_at === null ? null : { issuedAt: iso(q.issued_at), operationId: q.current_operation_id, issuerProfileId: q.issuer_profile_id },
    document: documentView(document),
    cancellation:
      q.cancelled_at === null
        ? null
        : { cancelledAt: iso(q.cancelled_at), reasonCode: q.cancellation_reason_code, initiatedBy: q.cancellation_initiated_by },
    expiration: effective.expiredAt === null ? null : { expiredAt: iso(effective.expiredAt) },
    createdByPrincipalId: q.created_by_principal_id,
    createdAt: iso(q.created_at),
    updatedAt: iso(q.updated_at)
  };
}

function groupBy<T extends { quote_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const group = groups.get(row.quote_id);

    if (group) {
      group.push(row);
    } else {
      groups.set(row.quote_id, [row]);
    }
  }

  return groups;
}

/**
 * Representations of already-selected quote rows: one query per child table
 * for the whole set (no N+1). Sequential: one client runs one query at a time.
 */
export async function loadQuoteViews(client: PoolClient, rows: readonly QuoteRow[], now: Date): Promise<QuoteView[]> {
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.quote_id);
  const lines = await client.query<LineRow>(
    `select *, unit_amount::text as unit from quote_service.quote_lines
     where quote_id = any($1::uuid[]) order by quote_id, position`,
    [ids]
  );
  const shipping = await client.query<ShippingRow>(
    `select *, amount::text as unit from quote_service.quote_shipping where quote_id = any($1::uuid[])`,
    [ids]
  );
  const documents = await client.query<DocumentRow>(
    `select quote_id, content_type, semantic_snapshot_hash, pdf_sha256, byte_length::text as byte_length,
            renderer_version, template_version, generated_at, artifact_ref
     from quote_service.quote_documents where quote_id = any($1::uuid[])`,
    [ids]
  );
  const linesByQuote = groupBy(lines.rows);
  const shippingByQuote = new Map(shipping.rows.map((row) => [row.quote_id, row]));
  const documentByQuote = new Map(documents.rows.map((row) => [row.quote_id, row]));

  return rows.map((row) =>
    quoteView(row, linesByQuote.get(row.quote_id) ?? [], shippingByQuote.get(row.quote_id), documentByQuote.get(row.quote_id), now)
  );
}

/** Contract `Quote` of a quote known to exist, in its current effective state. */
export async function readQuote(client: PoolClient, quoteId: string, clock: QuoteClock = databaseClock): Promise<QuoteView> {
  const { rows } = await client.query<QuoteRow>(`select ${QUOTE_COLUMNS} from quote_service.quotes q where q.quote_id = $1`, [quoteId]);
  return (await loadQuoteViews(client, rows, await clock.now(client)))[0]!;
}

const operationView = (o: OperationRow): OperationView => ({
  operationId: o.operation_id,
  type: o.operation_type,
  status: o.status,
  quoteId: o.quote_id,
  acceptedAt: iso(o.accepted_at),
  deadlineAt: iso(o.deadline_at),
  completedAt: iso(o.completed_at),
  // Lease owner, lease expiry and fencing generation are internal (contract `Operation`).
  attempts: {
    count: o.attempt_count,
    lastAttemptAt: iso(o.last_attempt_at),
    lastErrorCode: o.last_error_code,
    nextAttemptAt: iso(o.next_attempt_at)
  }
});

const OPERATION_COLUMNS = `o.operation_id, o.operation_type, o.status, o.quote_id, o.accepted_at, o.deadline_at, o.completed_at,
       o.attempt_count, o.last_attempt_at, o.last_error_code, o.next_attempt_at`;

/** Contract `Operation` of an operation known to exist. */
export async function readOperation(client: PoolClient, operationId: string): Promise<OperationView> {
  const { rows } = await client.query<OperationRow>(
    `select ${OPERATION_COLUMNS} from quote_service.issuance_operations o where o.operation_id = $1`,
    [operationId]
  );
  return operationView(rows[0]!);
}

/**
 * Current durable representation of an accepted quote and its operation, in
 * one consistent snapshot: the inline issuance response is built from this,
 * never from in-memory assumptions (Idempotency §4.4).
 */
export function readIssuanceResult(
  database: PostgresDatabase,
  quoteId: string,
  operationId: string,
  clock: QuoteClock = databaseClock
): Promise<{ quote: QuoteView; operation: OperationView }> {
  return withReadSnapshot(database, async (client) => ({
    quote: await readQuote(client, quoteId, clock),
    operation: await readOperation(client, operationId)
  }));
}

/** True while the operation is `pending` or `running`. */
export async function isOperationActive(database: PostgresDatabase, operationId: string): Promise<boolean> {
  const { rows } = await database.query<{ status: string }>(`select status from quote_service.issuance_operations where operation_id = $1`, [
    operationId
  ]);
  return rows[0]?.status === "pending" || rows[0]?.status === "running";
}

/**
 * `and <alias>.created_by_principal_id = $n` unless the principal holds
 * `quotes:read:any` (security §3). Appends the parameter it uses.
 */
export function visibilityClause(alias: string, principal: AuthenticatedPrincipal, values: unknown[]): string {
  if (hasScope(principal, "quotes:read:any")) {
    return "";
  }

  values.push(principal.principalId);
  return ` and ${alias}.created_by_principal_id = $${values.length}`;
}

/** One consistent snapshot per read (lines/shipping/manifest never mix two commits). */
export function withReadSnapshot<T>(database: PostgresDatabase, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.withTransaction(async (client) => {
    await client.query("set transaction isolation level repeatable read, read only");
    return work(client);
  });
}

export const quoteNotFound = () => new QuoteRequestRejected("quote_not_found", "Quote not found.");

/** `GET /v2/quotes/{quoteId}`: 404 when missing or not visible. */
export function getVisibleQuote(database: PostgresDatabase, principal: AuthenticatedPrincipal, quoteId: string, clock: QuoteClock): Promise<QuoteView> {
  return withReadSnapshot(database, async (client) => {
    const values: unknown[] = [quoteId];
    const visibility = visibilityClause("q", principal, values);
    const { rows } = await client.query<QuoteRow>(`select ${QUOTE_COLUMNS} from quote_service.quotes q where q.quote_id = $1${visibility}`, values);

    if (rows.length === 0) {
      throw quoteNotFound();
    }

    return (await loadQuoteViews(client, rows, await clock.now(client)))[0]!;
  });
}

/**
 * What `GET /v2/quotes/{quoteId}/document` needs (R1.5B4). Internal only:
 * the storage facts of the committed manifest are passed to the verified
 * read and never serialized into a response.
 */
export interface VisibleQuoteDocument {
  readonly quoteId: string;
  readonly quoteNumber: string | null;
  /** Effective (expiry-projected) status, for `document_not_available.details.status`. */
  readonly status: string;
  /** The committed manifest, or null when the quote never reached `issued`. */
  readonly manifest: (CommittedArtifactManifest & { readonly documentId: string }) | null;
}

/**
 * Document visibility is the quote's (security §3): 404 when missing or not
 * visible, exactly like `GET /v2/quotes/{id}`. One read-only snapshot of the
 * quote row and its manifest. A manifest exists only once T5 committed (or
 * for a migrated V1 document), so its presence is "reached `issued`"
 * whatever the current status (expired, cancelled after issue).
 */
export function getVisibleQuoteDocument(
  database: PostgresDatabase,
  principal: AuthenticatedPrincipal,
  quoteId: string,
  clock: QuoteClock
): Promise<VisibleQuoteDocument> {
  return withReadSnapshot(database, async (client) => {
    const values: unknown[] = [quoteId];
    const visibility = visibilityClause("q", principal, values);
    const { rows } = await client.query<{
      quote_id: string;
      quote_number: string | null;
      status: string;
      valid_until_exclusive: Date | null;
      expired_at: Date | null;
      document_id: string | null;
      origin: "issuance" | "legacy_v1" | null;
      storage_key: string | null;
      pdf_sha256: string | null;
      byte_length: string | null;
    }>(
      `select q.quote_id, q.quote_number, q.status, q.valid_until_exclusive, q.expired_at,
              d.document_id, d.origin, d.storage_key, d.pdf_sha256, d.byte_length::text as byte_length
       from quote_service.quotes q
       left join quote_service.quote_documents d on d.quote_id = q.quote_id
       where q.quote_id = $1${visibility}`,
      values
    );
    const row = rows[0];

    if (!row) {
      throw quoteNotFound();
    }

    const effective = effectiveExpiry({ status: row.status, validUntilExclusive: row.valid_until_exclusive, expiredAt: row.expired_at }, await clock.now(client));

    return {
      quoteId: row.quote_id,
      quoteNumber: row.quote_number,
      status: effective.status,
      manifest:
        row.document_id === null
          ? null
          : {
              documentId: row.document_id,
              origin: row.origin!,
              storageKey: row.storage_key!,
              pdfSha256: row.pdf_sha256!,
              byteLength: row.byte_length === null ? null : Number(row.byte_length)
            }
    };
  });
}

/** `GET /v2/operations/{operationId}`: visibility inherited from the quote; 404 otherwise. */
export function getVisibleOperation(database: PostgresDatabase, principal: AuthenticatedPrincipal, operationId: string): Promise<OperationView> {
  return withReadSnapshot(database, async (client) => {
    const values: unknown[] = [operationId];
    const visibility = visibilityClause("q", principal, values);
    const { rows } = await client.query<OperationRow>(
      `select ${OPERATION_COLUMNS}
       from quote_service.issuance_operations o join quote_service.quotes q on q.quote_id = o.quote_id
       where o.operation_id = $1${visibility}`,
      values
    );

    if (rows.length === 0) {
      throw new QuoteRequestRejected("operation_not_found", "Operation not found.");
    }

    return operationView(rows[0]!);
  });
}

// ---------- opaque cursors ----------

/** Thrown for a cursor that is malformed, tampered with or issued for another query (400). */
export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
}

const encodeCursor = (payload: Json): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

function decodeCursor(cursor: string): Json {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      return decoded as Json;
    }
  } catch {
    // fall through
  }

  throw new InvalidCursorError("cursor is invalid");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_INSTANT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;

// ---------- list ----------

export interface QuoteListQuery {
  readonly sourceSystem: string;
  readonly externalReferenceType?: string | undefined;
  readonly externalReference?: string | undefined;
  readonly status?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Binds a cursor to the filter set it was issued for (not to the principal: visibility is re-applied on every page). */
const filterFingerprint = (query: QuoteListQuery): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([query.sourceSystem, query.externalReferenceType ?? null, query.externalReference ?? null, query.status ?? null]))
    .digest("hex")
    .slice(0, 16);

/**
 * `GET /v2/quotes`: exact external-correlation match, visible quotes only,
 * ordered `createdAt desc, quoteId desc` (index quotes_external_correlation_idx)
 * with a keyset cursor at microsecond precision, so ties on `createdAt` are
 * stable and no row is skipped or repeated across pages. `status` filters on
 * the effective status, computed in SQL from the same clock instant as the
 * representation.
 */
export function listVisibleQuotes(
  database: PostgresDatabase,
  principal: AuthenticatedPrincipal,
  query: QuoteListQuery,
  clock: QuoteClock
): Promise<Page<QuoteView>> {
  const fingerprint = filterFingerprint(query);
  let after: { createdAt: string; quoteId: string } | null = null;

  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);

    if (
      decoded.v !== 1 ||
      decoded.f !== fingerprint ||
      typeof decoded.t !== "string" ||
      !CURSOR_INSTANT_PATTERN.test(decoded.t) ||
      typeof decoded.id !== "string" ||
      !UUID_PATTERN.test(decoded.id)
    ) {
      throw new InvalidCursorError("cursor is invalid");
    }

    after = { createdAt: decoded.t, quoteId: decoded.id };
  }

  return withReadSnapshot(database, async (client) => {
    const now = await clock.now(client);
    const values: unknown[] = [query.sourceSystem];
    let where = "q.source_system = $1";

    if (query.externalReferenceType !== undefined) {
      values.push(query.externalReferenceType, query.externalReference);
      where += ` and q.external_reference_type = $${values.length - 1} and q.external_reference = $${values.length}`;
    }

    where += visibilityClause("q", principal, values);

    if (query.status !== undefined) {
      values.push(now, query.status);
      where += ` and ${effectiveStatusSql("q", `$${values.length - 1}`)} = $${values.length}`;
    }

    if (after) {
      values.push(after.createdAt, after.quoteId);
      where += ` and (q.created_at, q.quote_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }

    values.push(query.limit + 1);
    const { rows } = await client.query<QuoteRow & { cursor_created_at: string }>(
      `select ${QUOTE_COLUMNS},
              to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from quote_service.quotes q
       where ${where}
       order by q.created_at desc, q.quote_id desc
       limit $${values.length}`,
      values
    );
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);

    return {
      items: await loadQuoteViews(client, pageRows, now),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ v: 1, f: fingerprint, t: last.cursor_created_at, id: last.quote_id }) : null
    };
  });
}

// ---------- audit ----------

const auditView = (e: AuditRow): Json => ({
  eventId: e.event_id,
  sequence: e.sequence,
  type: e.event_type,
  occurredAt: iso(e.occurred_at),
  principalId: e.principal_id,
  operationId: e.operation_id,
  correlationId: e.correlation_id,
  idempotencyKeyHash: e.idempotency_key_hash,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  data: e.data
});

/**
 * `GET /v2/quotes/{quoteId}/audit`: append-only history in `sequence` order
 * (unique per quote, so the keyset cursor is total). Visibility is the quote's.
 * Stored event data is already minimal and PII-free by construction
 * (Domain §11); raw keys and credentials are never stored, so never returned.
 */
export function listVisibleAudit(
  database: PostgresDatabase,
  principal: AuthenticatedPrincipal,
  quoteId: string,
  page: { limit: number; cursor?: string | undefined }
): Promise<Page<Json>> {
  let afterSequence = 0;

  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor);

    if (decoded.v !== 1 || decoded.q !== quoteId || !Number.isSafeInteger(decoded.s) || (decoded.s as number) < 1) {
      throw new InvalidCursorError("cursor is invalid");
    }

    afterSequence = decoded.s as number;
  }

  return withReadSnapshot(database, async (client) => {
    const values: unknown[] = [quoteId];
    const visibility = visibilityClause("q", principal, values);
    const visible = await client.query(`select 1 from quote_service.quotes q where q.quote_id = $1${visibility}`, values);

    if (visible.rows.length === 0) {
      throw quoteNotFound();
    }

    const { rows } = await client.query<AuditRow>(
      `select event_id, sequence, event_type, occurred_at, principal_id, operation_id, correlation_id,
              idempotency_key_hash, from_status, to_status, data
       from quote_service.quote_audit_events
       where quote_id = $1 and sequence > $2
       order by sequence
       limit $3`,
      [quoteId, afterSequence, page.limit + 1]
    );
    const pageRows = rows.slice(0, page.limit);
    const last = pageRows.at(-1);

    return {
      items: pageRows.map(auditView),
      nextCursor: rows.length > page.limit && last ? encodeCursor({ v: 1, q: quoteId, s: last.sequence }) : null
    };
  });
}

// ---------- idempotency lookup ----------

/**
 * `GET /v2/idempotency/current` (Idempotency §3.3). The scope is always the
 * authenticated principal's: there is no parameter that could name another
 * principal. Read-only: no audit, no binding. `quoteStatus` is the bound
 * quote's current effective status; the binding itself never changes.
 */
export function lookupIdempotencyBinding(
  database: PostgresDatabase,
  principal: AuthenticatedPrincipal,
  operation: IdempotentOperation,
  rawIdempotencyKey: string,
  clock: QuoteClock
): Promise<Json> {
  const scope = idempotencyScope(principal, operation, rawIdempotencyKey);

  return withReadSnapshot(database, async (client) => {
    const binding = await new PostgresIdempotencyBindingStore(client).find(scope);

    if (!binding) {
      return { operation, state: "not_found", binding: null };
    }

    const { rows } = await client.query<{ status: string; valid_until_exclusive: Date | null; expired_at: Date | null }>(
      `select status, valid_until_exclusive, expired_at from quote_service.quotes where quote_id = $1`,
      [binding.quoteId]
    );
    const quote = rows[0]!;
    const effective = effectiveExpiry(
      { status: quote.status, validUntilExclusive: quote.valid_until_exclusive, expiredAt: quote.expired_at },
      await clock.now(client)
    );

    return {
      operation,
      state: "bound",
      binding: {
        boundAt: formatInstant(new Date(binding.boundAt)),
        requestFingerprint: binding.requestFingerprint,
        resourceType: binding.resourceType,
        quoteId: binding.quoteId,
        operationId: binding.operationId,
        deliveryId: binding.deliveryId,
        quoteStatus: effective.status
      }
    };
  });
}
