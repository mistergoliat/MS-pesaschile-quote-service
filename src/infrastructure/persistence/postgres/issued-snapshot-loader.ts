import {
  ISSUED_SNAPSHOT_HASH_ALGORITHM,
  issuedSnapshotHash,
  SnapshotIntegrityError,
  type IssuedAmounts,
  type IssuedCharge,
  type IssuedLine,
  type IssuedProvenance,
  type IssuedShipping,
  type IssuedSnapshot
} from "../../../application/quote-v2/issued-snapshot";
import type { SqlQueryable } from "./postgres";

/*
 * Rebuilds the issued snapshot of an accepted quote from frozen PostgreSQL
 * state only (quote, lines, shipping): no Catalog, Shipping, CRM or customer
 * service, and no dependency on the public read projection
 * (quote-v2-reads.ts). Its own queries, row types and formatting, so a
 * change to a `GET` representation cannot reach the semantic snapshot hash.
 */

interface SnapshotQuoteRow {
  quote_id: string;
  quote_number: string | null;
  currency: string;
  issuer_profile_id: string | null;
  issued_at: Date | null;
  customer: Record<string, unknown>;
  net_amount: string;
  tax_amount: string;
  gross_amount: string;
  exempt_net_amount: string;
  validity_source: string | null;
  validity_policy_id: string | null;
  validity_issuer_zone: string | null;
  validity_tzdb_version: string | null;
  issue_local_date: string | null;
  through_local_date: string | null;
  valid_until_exclusive: Date | null;
  validity_override_principal_id: string | null;
  validity_override_reason_code: string | null;
}

interface SnapshotChargeRow {
  unit: string;
  tax_basis: string;
  tax_rate: string | null;
  net_amount: string;
  tax_amount: string;
  gross_amount: string;
}

interface SnapshotLineRow extends SnapshotChargeRow {
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

interface SnapshotShippingRow extends SnapshotChargeRow {
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

export interface IssuedSnapshotRows {
  readonly quote: SnapshotQuoteRow;
  readonly lines: readonly SnapshotLineRow[];
  readonly shipping: SnapshotShippingRow | null;
}

/** Contract `Instant`: UTC, millisecond precision, `.000` omitted. */
const instant = (value: Date): string => value.toISOString().replace(".000Z", "Z");
/** Canonical decimal string: no trailing fractional zeros (numeric(·, 6) comes back padded). */
const decimal = (value: string): string => (value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value);

/** Copies only the members that are present: absent optional members are omitted, never `null`. */
function present<T extends object>(members: { [K in keyof T]: T[K] | null }): T {
  return Object.fromEntries(Object.entries(members).filter(([, value]) => value !== null && value !== undefined)) as T;
}

const amounts = (row: SnapshotChargeRow): IssuedAmounts => ({
  net: Number(row.net_amount),
  tax: Number(row.tax_amount),
  gross: Number(row.gross_amount)
});

const charge = (row: SnapshotChargeRow): IssuedCharge =>
  present<IssuedCharge>({ amount: Number(row.unit), taxBasis: row.tax_basis, taxRate: row.tax_rate === null ? null : decimal(row.tax_rate) });

const provenance = (sourceSystem: string | null, reference: string | null, asOf: Date | null): IssuedProvenance | null =>
  sourceSystem === null ? null : present<IssuedProvenance>({ sourceSystem, reference, asOf: asOf === null ? null : instant(asOf) });

const line = (row: SnapshotLineRow): IssuedLine =>
  present<IssuedLine>({
    lineId: row.line_id,
    position: row.position,
    kind: row.kind,
    item: present<IssuedLine["item"]>({
      sourceSystem: row.item_source_system,
      productRef: row.item_product_ref,
      variantRef: row.item_variant_ref,
      sku: row.item_sku,
      description: row.item_description,
      attributes: row.item_attributes.length > 0 ? row.item_attributes : null
    }),
    quantity: { value: decimal(row.quantity), unit: row.quantity_unit },
    unitPrice: charge(row),
    pricingProvenance: provenance(row.pricing_source_system, row.pricing_reference, row.pricing_as_of),
    amounts: amounts(row)
  });

const shipping = (row: SnapshotShippingRow): IssuedShipping =>
  present<IssuedShipping>({
    carrier: present<IssuedShipping["carrier"]>({ code: row.carrier_code, name: row.carrier_name }),
    serviceType:
      row.service_type_code === null && row.service_type_name === null
        ? null
        : present<NonNullable<IssuedShipping["serviceType"]>>({ code: row.service_type_code, name: row.service_type_name }),
    destination: present<IssuedShipping["destination"]>({
      commune: row.destination_commune,
      region: row.destination_region,
      country: row.destination_country
    }),
    amount: charge(row),
    sourceQuote: provenance(row.source_quote_system, row.source_quote_reference, row.source_quote_as_of),
    amounts: amounts(row)
  });

/** Thrown when asked for the issued snapshot of a quote that was never accepted for issue. */
export class QuoteNotAcceptedError extends Error {
  override readonly name = "QuoteNotAcceptedError";
}

/** Pure: frozen rows → issued snapshot. Lines must be in `position` order. */
export function buildIssuedSnapshot(rows: IssuedSnapshotRows): IssuedSnapshot {
  const q = rows.quote;

  if (
    q.quote_number === null ||
    q.issuer_profile_id === null ||
    q.issued_at === null ||
    q.validity_source === null ||
    q.validity_issuer_zone === null ||
    q.issue_local_date === null ||
    q.through_local_date === null ||
    q.valid_until_exclusive === null
  ) {
    throw new QuoteNotAcceptedError("quote has no frozen issue snapshot");
  }

  return {
    quoteId: q.quote_id,
    quoteNumber: q.quote_number,
    currency: q.currency,
    issuerProfileId: q.issuer_profile_id,
    issuedAt: instant(q.issued_at),
    validity: {
      source: q.validity_source,
      policyId: q.validity_policy_id,
      issuerZone: q.validity_issuer_zone,
      tzdbVersion: q.validity_tzdb_version,
      issueLocalDate: q.issue_local_date,
      validThroughLocalDate: q.through_local_date,
      validUntilExclusive: instant(q.valid_until_exclusive),
      override:
        q.validity_override_principal_id === null || q.validity_override_reason_code === null
          ? null
          : { principalId: q.validity_override_principal_id, reasonCode: q.validity_override_reason_code }
    },
    customer: q.customer,
    lines: rows.lines.map(line),
    shipping: rows.shipping ? shipping(rows.shipping) : null,
    totals: {
      net: Number(q.net_amount),
      tax: Number(q.tax_amount),
      gross: Number(q.gross_amount),
      exemptNet: Number(q.exempt_net_amount)
    }
  };
}

/** The issued snapshot of an accepted quote, read in the caller's transaction (civil dates never pass through a JS Date). */
export async function loadIssuedSnapshot(client: SqlQueryable, quoteId: string): Promise<IssuedSnapshot> {
  const quote = await client.query<SnapshotQuoteRow>(
    `select quote_id, quote_number, currency, issuer_profile_id, issued_at, customer,
            net_amount::text as net_amount, tax_amount::text as tax_amount, gross_amount::text as gross_amount,
            exempt_net_amount::text as exempt_net_amount,
            validity_source, validity_policy_id, validity_issuer_zone, validity_tzdb_version,
            validity_issue_local_date::text as issue_local_date, validity_through_local_date::text as through_local_date,
            valid_until_exclusive, validity_override_principal_id, validity_override_reason_code
     from quote_service.quotes where quote_id = $1`,
    [quoteId]
  );

  if (quote.rows.length === 0) {
    throw new QuoteNotAcceptedError("quote not found");
  }

  const lines = await client.query<SnapshotLineRow>(
    `select line_id, position, kind, item_source_system, item_product_ref, item_variant_ref, item_sku, item_description,
            item_attributes, quantity::text as quantity, quantity_unit, unit_amount::text as unit, tax_basis,
            tax_rate::text as tax_rate, pricing_source_system, pricing_reference, pricing_as_of,
            net_amount::text as net_amount, tax_amount::text as tax_amount, gross_amount::text as gross_amount
     from quote_service.quote_lines where quote_id = $1 order by position`,
    [quoteId]
  );
  const shippingRows = await client.query<SnapshotShippingRow>(
    `select carrier_code, carrier_name, service_type_code, service_type_name, destination_commune, destination_region,
            destination_country, amount::text as unit, tax_basis, tax_rate::text as tax_rate, source_quote_system,
            source_quote_reference, source_quote_as_of,
            net_amount::text as net_amount, tax_amount::text as tax_amount, gross_amount::text as gross_amount
     from quote_service.quote_shipping where quote_id = $1`,
    [quoteId]
  );

  return buildIssuedSnapshot({ quote: quote.rows[0]!, lines: lines.rows, shipping: shippingRows.rows[0] ?? null });
}

export interface VerifiedIssuedSnapshot {
  readonly operationId: string;
  readonly snapshot: IssuedSnapshot;
  readonly snapshotHash: string;
}

/**
 * Pre-render integrity check (I7): reload the snapshot of the operation's
 * quote from the database, recompute its semantic hash and compare it with
 * the hash frozen on the operation at acceptance. A mismatch throws
 * SnapshotIntegrityError; nothing is rendered and nothing is "repaired".
 */
export async function loadVerifiedIssuedSnapshot(client: SqlQueryable, operationId: string): Promise<VerifiedIssuedSnapshot> {
  const { rows } = await client.query<{ quote_id: string; snapshot_hash: string; snapshot_hash_algorithm: string }>(
    `select quote_id, snapshot_hash, snapshot_hash_algorithm from quote_service.issuance_operations where operation_id = $1`,
    [operationId]
  );
  const operation = rows[0];

  if (!operation) {
    throw new QuoteNotAcceptedError("issuance operation not found");
  }

  const snapshot = await loadIssuedSnapshot(client, operation.quote_id);
  const actual = issuedSnapshotHash(snapshot);

  if (operation.snapshot_hash_algorithm !== ISSUED_SNAPSHOT_HASH_ALGORITHM || actual !== operation.snapshot_hash) {
    throw new SnapshotIntegrityError(operationId, operation.snapshot_hash, actual);
  }

  return { operationId, snapshot, snapshotHash: actual };
}
