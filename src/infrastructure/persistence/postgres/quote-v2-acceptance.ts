import crypto from "node:crypto";

import type { PoolClient } from "pg";
import type { z } from "zod";

import type { AuthenticatedPrincipal } from "../../../application/auth/principal";
import {
  idempotencyScope,
  type IdempotencyScope,
  type IdempotentOperation
} from "../../../application/idempotency/idempotency-scope";
import { sha256Jcs } from "../../../application/quote/canonical-json";
import {
  canonicalDecimal,
  chargeAmounts,
  MAX_CLP_AMOUNT,
  sumTotals,
  type ChargeAmounts,
  type TaxBasis
} from "../../../application/quote-v2/arithmetic";
import {
  createQuoteRequestSchema,
  QuoteRequestRejected,
  toFieldErrors,
  type LineInput,
  type ShippingInput
} from "../../../application/quote-v2/create-quote-request";
import {
  formatInstant,
  OverrideOutOfRangeError,
  resolveValidity,
  type ResolvedValidity
} from "../../../application/quote-v2/validity";
import { PostgresIdempotencyBindingStore, type IdempotencyBinding } from "./idempotency-binding-store";
import type { PostgresDatabase } from "./postgres";

const OPERATION: IdempotentOperation = "quote.create_and_issue";
const ISSUER_PROFILE_ID = "pesaschile-cl-v1";
const QUOTE_NUMBER_PREFIX = "PC";
// ponytail: fixed contract default (24 h); make it configuration (1–72 h) with the R1.5B worker.
const ISSUANCE_DEADLINE = "24 hours";

export type Json = Record<string, unknown>;

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

export type CommandOutcome<T> =
  | { readonly kind: "accepted" | "replayed"; readonly result: T }
  | { readonly kind: "conflict"; readonly boundRequestFingerprint: string };

export type AcceptOutcome = CommandOutcome<QuoteOperationResult>;

export interface AcceptCreateAndIssueInput {
  readonly principal: AuthenticatedPrincipal;
  /** The received JSON body, unmodified (fingerprint basis, Idempotency §2). */
  readonly body: unknown;
  readonly rawIdempotencyKey: string;
  /** Request/trace correlation (X-Correlation-Id); audit only, never on the quote. */
  readonly correlationId: string | null;
}

export const omitNull = (object: Json): Json =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

const amountsView = (row: AmountColumns) => ({
  net: Number(row.net_amount),
  tax: Number(row.tax_amount),
  gross: Number(row.gross_amount)
});

const chargeView = (row: ChargeColumns) =>
  omitNull({ amount: Number(row.unit), taxBasis: row.tax_basis, taxRate: row.tax_rate === null ? null : canonicalDecimal(row.tax_rate) });

const iso = (value: Date | null): string | null => (value === null ? null : formatInstant(value));

/** Contract `Quote` representation of the stored quote (no expiry projection: nothing reaches `issued` yet). */
export async function readQuote(client: PoolClient, quoteId: string): Promise<QuoteOperationResult["quote"]> {
  // Sequential: one client runs one query at a time (concurrent use is deprecated in pg).
  const quoteResult = await client.query<QuoteRow>(
    `select q.*, validity_issue_local_date::text as issue_local_date,
            validity_through_local_date::text as through_local_date
     from quote_service.quotes q where quote_id = $1`,
    [quoteId]
  );
  const linesResult = await client.query<LineRow>(
    `select *, unit_amount::text as unit from quote_service.quote_lines where quote_id = $1 order by position`,
    [quoteId]
  );
  const shippingResult = await client.query<ShippingRow>(
    `select *, amount::text as unit from quote_service.quote_shipping where quote_id = $1`,
    [quoteId]
  );
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

export async function readOperation(client: PoolClient, operationId: string): Promise<QuoteOperationResult["operation"]> {
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

export async function appendAudit(
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

export function parseRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new QuoteRequestRejected("validation_error", "Request body is invalid.", { fields: toFieldErrors(parsed.error) });
  }

  return parsed.data;
}

const overflow = (amounts: ChargeAmounts) => amounts.gross > MAX_CLP_AMOUNT;

interface ChargeInput {
  readonly amount: number;
  readonly taxBasis: TaxBasis;
  readonly taxRate?: string | undefined;
}

/** The arithmetic inputs of a complete snapshot: a request body, or the stored `Quote` representation. */
export interface CommercialSnapshot {
  readonly lines: ReadonlyArray<{ readonly quantity: { readonly value: string }; readonly unitPrice: ChargeInput }>;
  readonly shipping?: { readonly amount: ChargeInput } | null | undefined;
}

export interface ComputedSnapshot {
  readonly lines: readonly ChargeAmounts[];
  readonly shipping: ChargeAmounts | null;
  readonly totals: ReturnType<typeof sumTotals>;
  readonly computed: { readonly net: number; readonly tax: number; readonly gross: number };
}

/** Owner arithmetic over a complete snapshot (Domain §6.3); 422 when an amount overflows. */
export function computeSnapshot(snapshot: CommercialSnapshot): ComputedSnapshot {
  const lines = snapshot.lines.map(({ quantity, unitPrice }) =>
    chargeAmounts(unitPrice.amount, quantity.value, unitPrice.taxBasis, unitPrice.taxRate)
  );
  const shippingCharge = snapshot.shipping?.amount;
  const shipping = shippingCharge ? chargeAmounts(shippingCharge.amount, "1", shippingCharge.taxBasis, shippingCharge.taxRate) : null;
  const totals = sumTotals([
    ...lines.map((amounts, index) => ({ amounts, basis: snapshot.lines[index]!.unitPrice.taxBasis })),
    ...(shipping ? [{ amounts: shipping, basis: shippingCharge!.taxBasis }] : [])
  ]);

  if (lines.some(overflow) || (shipping && overflow(shipping)) || overflow(totals)) {
    throw new QuoteRequestRejected("validation_error", "Request body is invalid.", {
      fields: [{ path: "/lines", code: "amount_overflow", message: "A computed amount exceeds the supported range." }]
    });
  }

  return { lines, shipping, totals, computed: { net: Number(totals.net), tax: Number(totals.tax), gross: Number(totals.gross) } };
}

export function assertExpectedTotals(
  expected: ComputedSnapshot["computed"] | undefined,
  computed: ComputedSnapshot["computed"]
): void {
  if (expected && (expected.net !== computed.net || expected.tax !== computed.tax || expected.gross !== computed.gross)) {
    throw new QuoteRequestRejected("arithmetic_mismatch", "expectedTotals do not match owner-computed totals.", {
      expected,
      computed
    });
  }
}

export async function insertLines(
  client: PoolClient,
  quoteId: string,
  lines: readonly LineInput[],
  amounts: readonly ChargeAmounts[]
): Promise<void> {
  for (const [index, line] of lines.entries()) {
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
        amounts[index]!.net.toString(),
        amounts[index]!.tax.toString(),
        amounts[index]!.gross.toString()
      ]
    );
  }
}

export async function insertShipping(client: PoolClient, quoteId: string, input: ShippingInput, amounts: ChargeAmounts): Promise<void> {
  await client.query(
    `insert into quote_service.quote_shipping (
       quote_id, carrier_code, carrier_name, service_type_code, service_type_name, destination_commune,
       destination_region, destination_country, amount, tax_basis, tax_rate, source_quote_system,
       source_quote_reference, source_quote_as_of, net_amount, tax_amount, gross_amount
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      quoteId,
      input.carrier.code ?? null,
      input.carrier.name,
      input.serviceType?.code ?? null,
      input.serviceType?.name ?? null,
      input.destination.commune,
      input.destination.region ?? null,
      input.destination.country,
      input.amount.amount,
      input.amount.taxBasis,
      input.amount.taxRate ?? null,
      input.sourceQuote?.sourceSystem ?? null,
      input.sourceQuote?.reference ?? null,
      input.sourceQuote?.asOf ?? null,
      amounts.net.toString(),
      amounts.tax.toString(),
      amounts.gross.toString()
    ]
  );
}

export interface CommandContext {
  readonly principal: AuthenticatedPrincipal;
  readonly scope: IdempotencyScope;
  readonly fingerprint: string;
  /** Request/trace correlation (X-Correlation-Id); audit only, never on the quote. */
  readonly correlationId: string | null;
}

export function commandContext(
  input: { principal: AuthenticatedPrincipal; body: unknown; rawIdempotencyKey: string; correlationId: string | null },
  operation: IdempotentOperation,
  pathParameters: Record<string, string>
): CommandContext {
  return {
    principal: input.principal,
    scope: idempotencyScope(input.principal, operation, input.rawIdempotencyKey),
    // Idempotency §2: SHA-256(JCS({operation, pathParameters, body})) over the unmodified body.
    fingerprint: sha256Jcs({ operation, pathParameters, body: input.body }),
    correlationId: input.correlationId
  };
}

/**
 * Serializes same-scope requests (a concurrent duplicate waits for the first
 * commit) and answers a bound key before any resource, semantic, state or
 * version check (I-4): same fingerprint → replay of the bound resource in its
 * current state, else conflict. Returns null when the key is unbound.
 */
export async function answerFromBinding<T>(
  client: PoolClient,
  context: CommandContext,
  replay: (bound: IdempotencyBinding) => Promise<T>
): Promise<CommandOutcome<T> | null> {
  const { scope } = context;
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${scope.principalId}\n${scope.operation}\n${scope.keyHash}`
  ]);

  const bound = await new PostgresIdempotencyBindingStore(client).find(scope, client);

  if (!bound) {
    return null;
  }

  const replayed = bound.requestFingerprint === context.fingerprint;
  await appendAudit(client, {
    quoteId: bound.quoteId,
    type: replayed ? "idempotency.replayed" : "idempotency.conflict",
    principalId: context.principal.principalId,
    operationId: bound.operationId,
    correlationId: context.correlationId,
    keyHash: scope.keyHash,
    fromStatus: null,
    toStatus: null,
    data: { operation: scope.operation }
  });

  return replayed
    ? { kind: "replayed", result: await replay(bound) }
    : { kind: "conflict", boundRequestFingerprint: bound.requestFingerprint };
}

/** Binds the key in the transaction that commits its effect (I-2). */
export async function bind(
  client: PoolClient,
  context: CommandContext,
  body: unknown,
  resource: { quoteId: string; operationId: string | null }
): Promise<void> {
  await new PostgresIdempotencyBindingStore(client).insert(client, {
    ...context.scope,
    requestFingerprint: context.fingerprint,
    requestSnapshot: body,
    resourceType: "quote",
    quoteId: resource.quoteId,
    operationId: resource.operationId,
    deliveryId: null
  });
}

export interface IssueAllocation {
  readonly issuedAt: Date;
  readonly quoteNumber: string;
  readonly validity: ResolvedValidity;
}

/**
 * Issue effective instant, validity (§7) and quote number (§8), inside the
 * acceptance transaction. Validity (which can reject an override) is resolved
 * before the number is drawn; a later rollback leaves a gap, never a quote.
 */
export async function allocateIssue(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  override: { validThroughLocalDate: string; reasonCode: string } | undefined
): Promise<IssueAllocation> {
  const { rows } = await client.query<{ issued_at: Date }>(`select date_trunc('milliseconds', now()) as issued_at`);
  const issuedAt = rows[0]!.issued_at;
  let validity;

  try {
    validity = resolveValidity(
      issuedAt.getTime(),
      override
        ? { validThroughLocalDate: override.validThroughLocalDate, reasonCode: override.reasonCode, principalId: principal.principalId }
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

  const sequence = await client.query<{ sequence: string }>(`select nextval('quote_service.quote_number_seq')::text as sequence`);
  return { issuedAt, quoteNumber: `${QUOTE_NUMBER_PREFIX}-${sequence.rows[0]!.sequence.padStart(6, "0")}`, validity };
}

/**
 * Transition `draft → issuing` that freezes number, issuance and validity
 * (T3, and T4 after its in-transaction draft insert). Snapshot children are
 * only insertable under a draft (migration 000009), so every path writes the
 * commercial snapshot first and freezes last. `versionIncrement` is 1 for an
 * issued draft (T3) and 0 for create-and-issue (T4 commits at version 1).
 */
export async function freezeIssue(
  client: PoolClient,
  quoteId: string,
  { issuedAt, quoteNumber, validity }: IssueAllocation,
  operationId: string,
  versionIncrement: 0 | 1
): Promise<void> {
  await client.query(
    `update quote_service.quotes
     set status = 'issuing', version = version + $15, quote_number = $2, issued_at = $3, issuer_profile_id = $4,
         current_operation_id = $5, validity_source = $6, validity_policy_id = $7, validity_issuer_zone = $8,
         validity_tzdb_version = $9, validity_issue_local_date = $10, validity_through_local_date = $11,
         valid_until_exclusive = $12, validity_override_principal_id = $13, validity_override_reason_code = $14,
         updated_at = $3
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
      validity.override?.reasonCode ?? null,
      versionIncrement
    ]
  );
}

/**
 * Creates the pending issuance operation for a quote just frozen as `issuing`
 * and appends `quote.issue.accepted`. The operation is created last so it can
 * carry the snapshot hash read back from what was actually persisted
 * (quotes.current_operation_id is deferred).
 */
export async function createIssuanceOperation(
  client: PoolClient,
  context: CommandContext,
  input: {
    quoteId: string;
    operationId: string;
    allocation: IssueAllocation;
    fromStatus: "draft" | null;
    overrideNote: string | null;
    data: Json;
  }
): Promise<QuoteOperationResult> {
  const { quoteId, operationId, allocation } = input;
  const quote = await readQuote(client, quoteId);
  await client.query(
    `insert into quote_service.issuance_operations (
       operation_id, quote_id, operation_type, origin, status, generation, attempt_count, next_attempt_at,
       accepted_at, deadline_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
     ) values ($1, $2, 'quote.issue', 'acceptance', 'pending', 0, 0, $3, $3, $3::timestamptz + $4::interval, $5,
               'jcs-sha256-v2', $3, $3)`,
    [operationId, quoteId, allocation.issuedAt, ISSUANCE_DEADLINE, semanticSnapshotHash(quote)]
  );
  const { validity } = allocation;
  const correlation = quote.externalCorrelation as Json;
  await appendAudit(client, {
    quoteId,
    type: "quote.issue.accepted",
    principalId: context.principal.principalId,
    operationId,
    correlationId: context.correlationId,
    keyHash: context.scope.keyHash,
    fromStatus: input.fromStatus,
    toStatus: "issuing",
    data: omitNull({
      ...input.data,
      quoteNumber: allocation.quoteNumber,
      version: quote.version,
      lineCount: (quote.lines as unknown[]).length,
      hasShipping: quote.shipping !== null,
      gross: (quote.totals as Json).gross,
      validitySource: validity.source,
      validityPolicyId: validity.policyId,
      tzdbVersion: validity.tzdbVersion,
      validThroughLocalDate: validity.validThroughLocalDate,
      validUntilExclusive: validity.validUntilExclusive,
      overrideReasonCode: validity.override?.reasonCode ?? null,
      // The override note is audit-only (validity policy §2).
      overrideNote: input.overrideNote,
      externalReferenceType: correlation.externalReferenceType ?? null,
      externalReference: correlation.externalReference ?? null
    })
  });

  return { quote, operation: await readOperation(client, operationId) };
}

/**
 * Transactional create-and-issue acceptance (Domain §4.1, Idempotency §3).
 * One transaction: binding lookup under a per-scope lock (replay / conflict),
 * else validate, compute, allocate number, persist quote + lines + shipping +
 * validity + pending operation + audit + binding. Nothing else: no render, no
 * file, no email. 422 rejections roll back and bind nothing.
 */
export async function acceptCreateAndIssue(database: PostgresDatabase, input: AcceptCreateAndIssueInput): Promise<AcceptOutcome> {
  const context = commandContext(input, OPERATION, {});

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, async (bound) => ({
      quote: await readQuote(client, bound.quoteId),
      operation: await readOperation(client, bound.operationId!)
    }));

    if (answered) {
      return answered;
    }

    const request = parseRequest(createQuoteRequestSchema, input.body);
    const { lines, shipping, totals, computed } = computeSnapshot(request);
    assertExpectedTotals(request.expectedTotals, computed);
    const allocation = await allocateIssue(client, input.principal, request.validityOverride);
    const quoteId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlation = request.externalCorrelation;

    // Snapshot first (as a draft row, invisible outside this transaction), then freeze: T4 commits as issuing v1.
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
        allocation.issuedAt
      ]
    );
    await insertLines(client, quoteId, request.lines, lines);

    if (request.shipping && shipping) {
      await insertShipping(client, quoteId, request.shipping, shipping);
    }

    await freezeIssue(client, quoteId, allocation, operationId, 0);

    const result = await createIssuanceOperation(client, context, {
      quoteId,
      operationId,
      allocation,
      fromStatus: null,
      overrideNote: request.validityOverride?.note ?? null,
      data: {}
    });
    await bind(client, context, input.body, { quoteId, operationId });

    return { kind: "accepted", result };
  });
}
