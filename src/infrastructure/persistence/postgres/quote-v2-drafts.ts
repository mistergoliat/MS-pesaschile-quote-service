import crypto from "node:crypto";

import type { PoolClient } from "pg";

import { isCreator, type AuthenticatedPrincipal } from "../../../application/auth/principal";
import {
  createDraftRequestSchema,
  issueDraftRequestSchema,
  QuoteRequestRejected,
  updateDraftRequestSchema
} from "../../../application/quote-v2/create-quote-request";
import {
  allocateIssue,
  answerFromBinding,
  appendAudit,
  assertExpectedTotals,
  bind,
  commandContext,
  computeSnapshot,
  createIssuanceOperation,
  freezeIssue,
  insertLines,
  insertShipping,
  parseRequest,
  type AcceptCreateAndIssueInput,
  type AcceptOutcome,
  type CommandContext,
  type CommandOutcome,
  type CommercialSnapshot,
  type ComputedSnapshot
} from "./quote-v2-acceptance";
import type { PostgresDatabase } from "./postgres";
import { omitNull, readOperation, readQuote, type Json, type QuoteView } from "./quote-v2-reads";

/*
 * Manual flow (Domain §4.2, state machine T1–T3). Every command runs in one
 * transaction in the contract's evaluation order (Domain §12): binding lookup
 * (replay / conflict) → 404 (missing or not the creator, A4) → 422 request → 409
 * state → 409 version → draft-dependent checks → effect + audit + binding.
 * The quote row lock serializes edit and issue of the same draft, so exactly
 * one mutation can succeed from a given version.
 */

export type DraftCommandInput = AcceptCreateAndIssueInput;

export interface LockedQuote {
  status: string;
  version: number;
  quote_number: string | null;
  created_by_principal_id: string;
  current_operation_id: string | null;
  valid_until_exclusive: Date | null;
}

/**
 * Mutation authority (security §3, amendment A4): only the creator principal may
 * edit, issue or cancel; `quotes:read:any` grants no mutation. Any other quote is
 * answered exactly like a missing one (existence hiding).
 */
export async function lockOwnQuote(client: PoolClient, quoteId: string, principal: AuthenticatedPrincipal): Promise<LockedQuote> {
  const { rows } = await client.query<LockedQuote>(
    `select status, version, quote_number, created_by_principal_id, current_operation_id, valid_until_exclusive
     from quote_service.quotes where quote_id = $1 for update`,
    [quoteId]
  );
  const quote = rows[0];

  if (!quote || !isCreator(principal, quote.created_by_principal_id)) {
    throw new QuoteRequestRejected("quote_not_found", "Quote not found.");
  }

  return quote;
}

/** State machine §4: only a draft at exactly `expectedVersion` can be edited or issued. */
function assertDraftAtVersion(quote: LockedQuote, expectedVersion: number): void {
  if (quote.status === "issuing") {
    throw new QuoteRequestRejected("operation_in_progress", "The quote is issuing; retry after the operation completes.", {
      operationId: quote.current_operation_id
    });
  }

  if (quote.status !== "draft") {
    throw new QuoteRequestRejected("invalid_state_transition", "The operation is not allowed in the quote's current state.", {
      status: quote.status
    });
  }

  if (quote.version !== expectedVersion) {
    throw new QuoteRequestRejected("version_conflict", "expectedVersion does not match the current quote version.", {
      expectedVersion,
      currentVersion: quote.version
    });
  }
}

/** Minimal non-PII audit data for draft events (Domain §11). */
function draftAuditData(quote: QuoteView): Json {
  const correlation = quote.externalCorrelation as Json;
  return omitNull({
    version: quote.version,
    lineCount: (quote.lines as unknown[]).length,
    hasShipping: quote.shipping !== null,
    gross: (quote.totals as Json).gross,
    externalReferenceType: correlation.externalReferenceType ?? null,
    externalReference: correlation.externalReference ?? null
  });
}

function amountColumns({ totals }: ComputedSnapshot): string[] {
  return [totals.net.toString(), totals.tax.toString(), totals.gross.toString(), totals.exemptNet.toString()];
}

async function recordDraftEvent(
  client: PoolClient,
  context: CommandContext,
  quoteId: string,
  type: "quote.draft.created" | "quote.draft.updated",
  data: Json
): Promise<QuoteView> {
  const quote = await readQuote(client, quoteId);
  await appendAudit(client, {
    quoteId,
    type,
    principalId: context.principal.principalId,
    operationId: null,
    correlationId: context.correlationId,
    keyHash: context.scope.keyHash,
    fromStatus: type === "quote.draft.created" ? null : "draft",
    toStatus: "draft",
    data: { ...draftAuditData(quote), ...data }
  });
  return quote;
}

/** T1 — `POST /v2/quotes/drafts`: version 1, owner totals, no number, validity, operation or document. */
export async function createDraft(database: PostgresDatabase, input: DraftCommandInput): Promise<CommandOutcome<QuoteView>> {
  const context = commandContext(input, "quote.draft.create", {});

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, (bound) => readQuote(client, bound.quoteId, input.clock));

    if (answered) {
      return answered;
    }

    const request = parseRequest(createDraftRequestSchema, input.body);
    const computed = computeSnapshot(request);
    const quoteId = crypto.randomUUID();
    const correlation = request.externalCorrelation;

    await client.query(
      `insert into quote_service.quotes (
         quote_id, status, version, currency, source_system, external_reference_type, external_reference, customer,
         net_amount, tax_amount, gross_amount, exempt_net_amount, created_by_principal_id, created_at, updated_at
       ) values ($1, 'draft', 1, 'CLP', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 date_trunc('milliseconds', now()), date_trunc('milliseconds', now()))`,
      [
        quoteId,
        correlation.sourceSystem,
        correlation.externalReferenceType ?? null,
        correlation.externalReference ?? null,
        JSON.stringify(request.customer),
        ...amountColumns(computed),
        input.principal.principalId
      ]
    );
    await insertLines(client, quoteId, request.lines, computed.lines);

    if (request.shipping) {
      await insertShipping(client, quoteId, request.shipping, computed.shipping!);
    }

    const quote = await recordDraftEvent(client, context, quoteId, "quote.draft.created", {});
    await bind(client, context, input.body, { quoteId, operationId: null });

    return { kind: "accepted", result: quote };
  });
}

/**
 * T2 — `PATCH /v2/quotes/{quoteId}/draft`: each present member replaces the
 * stored one (arrays whole, `shipping: null` removes); totals are recomputed
 * from the resulting complete snapshot; version + 1.
 */
export async function updateDraft(
  database: PostgresDatabase,
  quoteId: string,
  input: DraftCommandInput
): Promise<CommandOutcome<QuoteView>> {
  const context = commandContext(input, "quote.draft.update", { quoteId });

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, (bound) => readQuote(client, bound.quoteId, input.clock));

    if (answered) {
      return answered;
    }

    const locked = await lockOwnQuote(client, quoteId, input.principal);
    const patch = parseRequest(updateDraftRequestSchema, input.body);
    assertDraftAtVersion(locked, patch.expectedVersion);

    const current = await readQuote(client, quoteId);
    const computed = computeSnapshot({
      lines: patch.lines ?? (current.lines as CommercialSnapshot["lines"]),
      shipping: patch.shipping === undefined ? (current.shipping as CommercialSnapshot["shipping"]) : patch.shipping
    });
    const correlation = patch.externalCorrelation ?? (current.externalCorrelation as typeof patch.externalCorrelation & object);

    await client.query(
      `update quote_service.quotes
       set source_system = $2, external_reference_type = $3, external_reference = $4, customer = $5,
           net_amount = $6, tax_amount = $7, gross_amount = $8, exempt_net_amount = $9,
           version = version + 1, updated_at = date_trunc('milliseconds', now())
       where quote_id = $1`,
      [
        quoteId,
        correlation.sourceSystem,
        correlation.externalReferenceType ?? null,
        correlation.externalReference ?? null,
        JSON.stringify(patch.customer ?? current.customer),
        ...amountColumns(computed)
      ]
    );

    if (patch.lines) {
      await client.query(`delete from quote_service.quote_lines where quote_id = $1`, [quoteId]);
      await insertLines(client, quoteId, patch.lines, computed.lines);
    }

    if (patch.shipping !== undefined) {
      await client.query(`delete from quote_service.quote_shipping where quote_id = $1`, [quoteId]);

      if (patch.shipping) {
        await insertShipping(client, quoteId, patch.shipping, computed.shipping!);
      }
    }

    const quote = await recordDraftEvent(client, context, quoteId, "quote.draft.updated", {
      previousVersion: locked.version,
      replacedMembers: Object.keys(patch).filter((member) => member !== "expectedVersion").sort()
    });
    await bind(client, context, input.body, { quoteId, operationId: null });

    return { kind: "accepted", result: quote };
  });
}

/**
 * T3 — `POST /v2/quotes/{quoteId}/issue`: the same acceptance as
 * create-and-issue applied to the stored draft at `expectedVersion`. The
 * snapshot is exactly the draft's: nothing is repriced or refetched. Same
 * quoteId; number, validity and the pending operation are created here.
 */
export async function issueDraft(database: PostgresDatabase, quoteId: string, input: DraftCommandInput): Promise<AcceptOutcome> {
  const context = commandContext(input, "quote.issue", { quoteId });

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, async (bound) => ({
      quote: await readQuote(client, bound.quoteId, input.clock),
      operation: await readOperation(client, bound.operationId!)
    }));

    if (answered) {
      return answered;
    }

    const locked = await lockOwnQuote(client, quoteId, input.principal);
    const request = parseRequest(issueDraftRequestSchema, input.body);
    assertDraftAtVersion(locked, request.expectedVersion);

    const draft = await readQuote(client, quoteId);
    const snapshot = draft as unknown as CommercialSnapshot;

    if (snapshot.lines.length === 0) {
      throw new QuoteRequestRejected("validation_error", "Request body is invalid.", {
        fields: [{ path: "/lines", code: "lines_required", message: "Issue requires at least one line." }]
      });
    }

    // Same engine as the draft writes; a difference is stored-data corruption, never a reprice.
    const computed = computeSnapshot(snapshot);
    const stored = draft.totals as Json;

    if (
      stored.net !== computed.computed.net ||
      stored.tax !== computed.computed.tax ||
      stored.gross !== computed.computed.gross ||
      stored.exemptNet !== Number(computed.totals.exemptNet)
    ) {
      throw new Error("Stored draft totals diverge from owner arithmetic");
    }

    assertExpectedTotals(request.expectedTotals, computed.computed);
    const allocation = await allocateIssue(client, input.principal, request.validityOverride);
    const operationId = crypto.randomUUID();

    await freezeIssue(client, quoteId, allocation, operationId, 1);

    const result = await createIssuanceOperation(client, context, {
      quoteId,
      operationId,
      allocation,
      issuanceDeadlineMs: input.issuanceDeadlineMs,
      fromStatus: "draft",
      overrideNote: request.validityOverride?.note ?? null,
      data: { issuedDraftVersion: locked.version }
    });
    await bind(client, context, input.body, { quoteId, operationId });

    return { kind: "accepted", result };
  });
}
