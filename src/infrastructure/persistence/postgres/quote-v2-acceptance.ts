import crypto from "node:crypto";

import type { PoolClient } from "pg";

import type { AuthenticatedPrincipal } from "../../../application/auth/principal";
import { idempotencyScope, type IdempotentOperation } from "../../../application/idempotency/idempotency-scope";
import { sha256Jcs } from "../../../application/quote/canonical-json";
import {
  canonicalDecimal,
  chargeAmounts,
  MAX_CLP_AMOUNT,
  sumTotals,
  type ChargeAmounts
} from "../../../application/quote-v2/arithmetic";
import {
  createQuoteRequestSchema,
  QuoteRequestRejected,
  toFieldErrors,
  type CreateQuoteRequest
} from "../../../application/quote-v2/create-quote-request";
import {
  formatInstant,
  OverrideOutOfRangeError,
  resolveValidity,
  type ResolvedValidity
} from "../../../application/quote-v2/validity";
import { PostgresIdempotencyBindingStore } from "./idempotency-binding-store";
import type { PostgresDatabase } from "./postgres";

const OPERATION: IdempotentOperation = "quote.create_and_issue";
const ISSUER_PROFILE_ID = "pesaschile-cl-v1";
const QUOTE_NUMBER_PREFIX = "PC";
// ponytail: fixed contract default (24 h); make it configuration (1–72 h) with the R1.5B worker.
const ISSUANCE_DEADLINE = "24 hours";

type Json = Record<string, unknown>;

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

interface QuoteRow extends AmountColumns {
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

export interface QuoteOperationResult {
  readonly quote: Json & { readonly quoteId: string; readonly status: string };
  readonly operation: Json & { readonly operationId: string };
}

export type AcceptOutcome =
  | { readonly kind: "accepted" | "replayed"; readonly result: QuoteOperationResult }
  | { readonly kind: "conflict"; readonly boundRequestFingerprint: string };

export interface AcceptCreateAndIssueInput {
  readonly principal: AuthenticatedPrincipal;
  /** The received JSON body, unmodified (fingerprint basis, Idempotency §2). */
  readonly body: unknown;
  readonly rawIdempotencyKey: string;
  /** Request/trace correlation (X-Correlation-Id); audit only, never on the quote. */
  readonly correlationId: string | null;
}

const omitNull = (object: Json): Json =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

const amountsView = (row: AmountColumns) => ({
  net: Number(row.net_amount),
  tax: Number(row.tax_amount),
  gross: Number(row.gross_amount)
});

const chargeView = (row: ChargeColumns) =>
  omitNull({ amount: Number(row.unit), taxBasis: row.tax_basis, taxRate: row.tax_rate === null ? null : canonicalDecimal(row.tax_rate) });

const iso = (value: Date | null): string | null => (value === null ? null : formatInstant(value));

/** Contract `Quote` representation of the stored quote (no expiry projection: only `issuing` exists yet). */
async function readQuote(client: PoolClient, quoteId: string): Promise<QuoteOperationResult["quote"]> {
  const [quoteResult, linesResult, shippingResult] = await Promise.all([
    client.query<QuoteRow>(
      `select q.*, validity_issue_local_date::text as issue_local_date,
              validity_through_local_date::text as through_local_date
       from quote_service.quotes q where quote_id = $1`,
      [quoteId]
    ),
    client.query<LineRow>(`select *, unit_amount::text as unit from quote_service.quote_lines where quote_id = $1 order by position`, [quoteId]),
    client.query<ShippingRow>(`select *, amount::text as unit from quote_service.quote_shipping where quote_id = $1`, [quoteId])
  ]);
  const q = quoteResult.rows[0]!;
  const s = shippingResult.rows[0];

  return {
    quoteId: q.quote_id,
    status: q.status,
    version: q.version,
    quoteNumber: q.quote_number,
    currency: q.currency,
    externalCorrelation: omitNull({
      sourceSystem: q.source_system,
      externalReferenceType: q.external_reference_type,
      externalReference: q.external_reference
    }),
    customer: q.customer,
    lines: linesResult.rows.map((line) =>
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
      })
    ),
    shipping: s
      ? omitNull({
          carrier: omitNull({ code: s.carrier_code, name: s.carrier_name }),
          serviceType:
            s.service_type_code === null && s.service_type_name === null
              ? null
              : omitNull({ code: s.service_type_code, name: s.service_type_name }),
          destination: omitNull({ commune: s.destination_commune, region: s.destination_region, country: s.destination_country }),
          amount: chargeView(s),
          sourceQuote:
            s.source_quote_system === null
              ? null
              : omitNull({ sourceSystem: s.source_quote_system, reference: s.source_quote_reference, asOf: iso(s.source_quote_as_of) }),
          amounts: amountsView(s)
        })
      : null,
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
      q.issued_at === null
        ? null
        : { issuedAt: iso(q.issued_at), operationId: q.current_operation_id, issuerProfileId: q.issuer_profile_id },
    // ponytail: manifest not read yet; no quote can reach `issued` before the R1.5B worker.
    document: {
      available: false,
      contentType: "application/pdf",
      semanticSnapshotHash: null,
      pdfSha256: null,
      byteLength: null,
      rendererVersion: null,
      templateVersion: null,
      generatedAt: null,
      artifactRef: null
    },
    cancellation:
      q.cancelled_at === null
        ? null
        : { cancelledAt: iso(q.cancelled_at), reasonCode: q.cancellation_reason_code, initiatedBy: q.cancellation_initiated_by },
    expiration: q.expired_at === null ? null : { expiredAt: iso(q.expired_at) },
    createdByPrincipalId: q.created_by_principal_id,
    createdAt: iso(q.created_at),
    updatedAt: iso(q.updated_at)
  };
}

async function readOperation(client: PoolClient, operationId: string): Promise<QuoteOperationResult["operation"]> {
  const { rows } = await client.query<OperationRow>(`select * from quote_service.issuance_operations where operation_id = $1`, [operationId]);
  const o = rows[0]!;

  return {
    operationId: o.operation_id,
    type: o.operation_type,
    status: o.status,
    quoteId: o.quote_id,
    acceptedAt: iso(o.accepted_at),
    deadlineAt: iso(o.deadline_at),
    completedAt: iso(o.completed_at),
    attempts: {
      count: o.attempt_count,
      lastAttemptAt: iso(o.last_attempt_at),
      lastErrorCode: o.last_error_code,
      nextAttemptAt: iso(o.next_attempt_at)
    }
  };
}

/** Domain §9.2: SHA-256(JCS) of the issued snapshot fields. */
export function semanticSnapshotHash(quote: QuoteOperationResult["quote"]): string {
  return sha256Jcs({
    quoteId: quote.quoteId,
    quoteNumber: quote.quoteNumber,
    currency: quote.currency,
    issuerProfileId: (quote.issuance as Json).issuerProfileId,
    issuedAt: (quote.issuance as Json).issuedAt,
    validity: quote.validity,
    customer: quote.customer,
    lines: quote.lines,
    shipping: quote.shipping,
    totals: quote.totals
  });
}

async function appendAudit(
  client: PoolClient,
  event: {
    quoteId: string;
    type: string;
    principalId: string;
    operationId: string | null;
    correlationId: string | null;
    keyHash: string | null;
    fromStatus: string | null;
    toStatus: string | null;
    data: Json;
  }
): Promise<void> {
  // The quote row lock serializes per-quote sequence allocation.
  await client.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [event.quoteId]);
  await client.query(
    `insert into quote_service.quote_audit_events (
       event_id, quote_id, sequence, event_type, occurred_at, principal_id, operation_id, correlation_id,
       idempotency_key_hash, from_status, to_status, data
     ) values ($1, $2, (select coalesce(max(sequence), 0) + 1 from quote_service.quote_audit_events where quote_id = $2),
               $3, now(), $4, $5, $6, $7, $8, $9, $10)`,
    [
      crypto.randomUUID(),
      event.quoteId,
      event.type,
      event.principalId,
      event.operationId,
      event.correlationId,
      event.keyHash,
      event.fromStatus,
      event.toStatus,
      JSON.stringify(event.data)
    ]
  );
}

/** Transition `draft → issuing` that freezes number, issuance and validity; version unchanged (T4 commits at 1). */
async function freezeIssue(
  client: PoolClient,
  quoteId: string,
  { issuedAt, quoteNumber, validity }: { issuedAt: Date; quoteNumber: string; validity: ResolvedValidity },
  operationId: string
): Promise<void> {
  await client.query(
    `update quote_service.quotes
     set status = 'issuing', quote_number = $2, issued_at = $3, issuer_profile_id = $4, current_operation_id = $5,
         validity_source = $6, validity_policy_id = $7, validity_issuer_zone = $8, validity_tzdb_version = $9,
         validity_issue_local_date = $10, validity_through_local_date = $11, valid_until_exclusive = $12,
         validity_override_principal_id = $13, validity_override_reason_code = $14, updated_at = $3
     where quote_id = $1 and status = 'draft'`,
    [
      quoteId,
      quoteNumber,
      issuedAt,
      ISSUER_PROFILE_ID,
      operationId,
      validity.source,
      validity.policyId,
      validity.issuerZone,
      validity.tzdbVersion,
      validity.issueLocalDate,
      validity.validThroughLocalDate,
      validity.validUntilExclusive,
      validity.override?.principalId ?? null,
      validity.override?.reasonCode ?? null
    ]
  );
}

function parseRequest(body: unknown): CreateQuoteRequest {
  const parsed = createQuoteRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new QuoteRequestRejected("validation_error", "Request body is invalid.", { fields: toFieldErrors(parsed.error) });
  }

  return parsed.data;
}

const overflow = (amounts: ChargeAmounts) => amounts.gross > MAX_CLP_AMOUNT;

/**
 * Transactional create-and-issue acceptance (Domain §4.1, Idempotency §3).
 * One transaction: binding lookup under a per-scope lock (replay / conflict),
 * else validate, compute, allocate number, persist quote + lines + shipping +
 * validity + pending operation + audit + binding. Nothing else: no render, no
 * file, no email. 422 rejections roll back and bind nothing.
 */
export async function acceptCreateAndIssue(database: PostgresDatabase, input: AcceptCreateAndIssueInput): Promise<AcceptOutcome> {
  const scope = idempotencyScope(input.principal, OPERATION, input.rawIdempotencyKey);
  const fingerprint = sha256Jcs({ operation: OPERATION, pathParameters: {}, body: input.body });
  const bindings = new PostgresIdempotencyBindingStore(database);

  return database.withTransaction(async (client) => {
    // Same-scope requests serialize here: a concurrent duplicate waits for the
    // first commit and then replays or conflicts (Idempotency §3.2).
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${scope.principalId}\n${scope.operation}\n${scope.keyHash}`
    ]);

    const bound = await bindings.find(scope, client);

    if (bound) {
      const replay = bound.requestFingerprint === fingerprint;
      await appendAudit(client, {
        quoteId: bound.quoteId,
        type: replay ? "idempotency.replayed" : "idempotency.conflict",
        principalId: input.principal.principalId,
        operationId: bound.operationId,
        correlationId: input.correlationId,
        keyHash: scope.keyHash,
        fromStatus: null,
        toStatus: null,
        data: { operation: OPERATION }
      });

      return replay
        ? {
            kind: "replayed",
            result: { quote: await readQuote(client, bound.quoteId), operation: await readOperation(client, bound.operationId!) }
          }
        : { kind: "conflict", boundRequestFingerprint: bound.requestFingerprint };
    }

    const request = parseRequest(input.body);
    const lines = request.lines.map((line) => ({
      line,
      amounts: chargeAmounts(line.unitPrice.amount, line.quantity.value, line.unitPrice.taxBasis, line.unitPrice.taxRate)
    }));
    const shipping = request.shipping
      ? chargeAmounts(request.shipping.amount.amount, "1", request.shipping.amount.taxBasis, request.shipping.amount.taxRate)
      : null;
    const totals = sumTotals([
      ...lines.map(({ line, amounts }) => ({ amounts, basis: line.unitPrice.taxBasis })),
      ...(shipping ? [{ amounts: shipping, basis: request.shipping!.amount.taxBasis }] : [])
    ]);

    if (lines.some(({ amounts }) => overflow(amounts)) || (shipping && overflow(shipping)) || overflow(totals)) {
      throw new QuoteRequestRejected("validation_error", "Request body is invalid.", {
        fields: [{ path: "/lines", code: "amount_overflow", message: "A computed amount exceeds the supported range." }]
      });
    }

    const computed = { net: Number(totals.net), tax: Number(totals.tax), gross: Number(totals.gross) };
    const expected = request.expectedTotals;

    if (expected && (expected.net !== computed.net || expected.tax !== computed.tax || expected.gross !== computed.gross)) {
      throw new QuoteRequestRejected("arithmetic_mismatch", "expectedTotals do not match owner-computed totals.", {
        expected,
        computed
      });
    }

    // Issue effective instant and number come from the database, inside the
    // acceptance transaction. A rollback after nextval leaves a gap, never a quote.
    const allocation = await client.query<{ issued_at: Date; sequence: string }>(
      `select date_trunc('milliseconds', now()) as issued_at, nextval('quote_service.quote_number_seq')::text as sequence`
    );
    const { issued_at: issuedAt, sequence } = allocation.rows[0]!;
    const quoteNumber = `${QUOTE_NUMBER_PREFIX}-${sequence.padStart(6, "0")}`;
    let validity;

    try {
      validity = resolveValidity(
        issuedAt.getTime(),
        request.validityOverride
          ? {
              validThroughLocalDate: request.validityOverride.validThroughLocalDate,
              reasonCode: request.validityOverride.reasonCode,
              principalId: input.principal.principalId
            }
          : undefined
      );
    } catch (error) {
      if (error instanceof OverrideOutOfRangeError) {
        throw new QuoteRequestRejected("validation_error", "Request body is invalid.", {
          fields: [{ path: "/validityOverride/validThroughLocalDate", code: "override_out_of_range", message: error.message }]
        });
      }

      throw error;
    }

    const quoteId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlation = request.externalCorrelation;

    // Snapshot first (as a draft row, invisible outside this transaction), then freeze: snapshot
    // children are insertable only under a draft (migration 000009). Commits as issuing v1.
    await client.query(
      `insert into quote_service.quotes (
         quote_id, status, version, currency, source_system, external_reference_type, external_reference,
         customer, net_amount, tax_amount, gross_amount, exempt_net_amount, created_by_principal_id, created_at, updated_at
       ) values ($1, 'draft', 1, 'CLP', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        quoteId,
        correlation.sourceSystem,
        correlation.externalReferenceType ?? null,
        correlation.externalReference ?? null,
        JSON.stringify(request.customer),
        totals.net.toString(),
        totals.tax.toString(),
        totals.gross.toString(),
        totals.exemptNet.toString(),
        input.principal.principalId,
        issuedAt
      ]
    );

    for (const [index, { line, amounts }] of lines.entries()) {
      await client.query(
        `insert into quote_service.quote_lines (
           line_id, quote_id, position, kind, item_source_system, item_product_ref, item_variant_ref, item_sku,
           item_description, item_attributes, quantity, quantity_unit, unit_amount, tax_basis, tax_rate,
           pricing_source_system, pricing_reference, pricing_as_of, net_amount, tax_amount, gross_amount
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          crypto.randomUUID(),
          quoteId,
          index + 1,
          line.kind,
          line.item.sourceSystem,
          line.item.productRef ?? null,
          line.item.variantRef ?? null,
          line.item.sku ?? null,
          line.item.description,
          JSON.stringify(line.item.attributes ?? []),
          line.quantity.value,
          line.quantity.unit,
          line.unitPrice.amount,
          line.unitPrice.taxBasis,
          line.unitPrice.taxRate ?? null,
          line.pricingProvenance?.sourceSystem ?? null,
          line.pricingProvenance?.reference ?? null,
          line.pricingProvenance?.asOf ?? null,
          amounts.net.toString(),
          amounts.tax.toString(),
          amounts.gross.toString()
        ]
      );
    }

    if (request.shipping && shipping) {
      const input_ = request.shipping;
      await client.query(
        `insert into quote_service.quote_shipping (
           quote_id, carrier_code, carrier_name, service_type_code, service_type_name, destination_commune,
           destination_region, destination_country, amount, tax_basis, tax_rate, source_quote_system,
           source_quote_reference, source_quote_as_of, net_amount, tax_amount, gross_amount
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          quoteId,
          input_.carrier.code ?? null,
          input_.carrier.name,
          input_.serviceType?.code ?? null,
          input_.serviceType?.name ?? null,
          input_.destination.commune,
          input_.destination.region ?? null,
          input_.destination.country,
          input_.amount.amount,
          input_.amount.taxBasis,
          input_.amount.taxRate ?? null,
          input_.sourceQuote?.sourceSystem ?? null,
          input_.sourceQuote?.reference ?? null,
          input_.sourceQuote?.asOf ?? null,
          shipping.net.toString(),
          shipping.tax.toString(),
          shipping.gross.toString()
        ]
      );
    }

    await freezeIssue(client, quoteId, { issuedAt, quoteNumber, validity }, operationId);

    // The operation is created last so it can carry the snapshot hash read back
    // from what was actually persisted (quotes.current_operation_id is deferred).
    const quote = await readQuote(client, quoteId);
    await client.query(
      `insert into quote_service.issuance_operations (
         operation_id, quote_id, operation_type, origin, status, generation, attempt_count, next_attempt_at,
         accepted_at, deadline_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
       ) values ($1, $2, 'quote.issue', 'acceptance', 'pending', 0, 0, $3, $3, $3::timestamptz + $4::interval, $5,
                 'jcs-sha256-v2', $3, $3)`,
      [operationId, quoteId, issuedAt, ISSUANCE_DEADLINE, semanticSnapshotHash(quote)]
    );
    await appendAudit(client, {
      quoteId,
      type: "quote.issue.accepted",
      principalId: input.principal.principalId,
      operationId,
      correlationId: input.correlationId,
      keyHash: scope.keyHash,
      fromStatus: null,
      toStatus: "issuing",
      data: omitNull({
        quoteNumber,
        lineCount: lines.length,
        hasShipping: shipping !== null,
        gross: computed.gross,
        validitySource: validity.source,
        validityPolicyId: validity.policyId,
        tzdbVersion: validity.tzdbVersion,
        overrideReasonCode: validity.override?.reasonCode ?? null,
        // The override note is audit-only (validity policy §2).
        overrideNote: request.validityOverride?.note ?? null,
        externalReferenceType: correlation.externalReferenceType ?? null,
        externalReference: correlation.externalReference ?? null
      })
    });
    await bindings.insert(client, {
      ...scope,
      requestFingerprint: fingerprint,
      requestSnapshot: input.body,
      resourceType: "quote",
      quoteId,
      operationId,
      deliveryId: null
    });

    return { kind: "accepted", result: { quote, operation: await readOperation(client, operationId) } };
  });
}
