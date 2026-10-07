import { cancelRequestSchema, QuoteRequestRejected } from "../../../application/quote-v2/create-quote-request";
import { isPastValidity } from "../../../application/quote-v2/expiry";
import { answerFromBinding, appendAudit, bind, commandContext, parseRequest, type CommandOutcome } from "./quote-v2-acceptance";
import { lockOwnQuote, type DraftCommandInput } from "./quote-v2-drafts";
import type { PostgresDatabase } from "./postgres";
import { databaseClock } from "./quote-clock";
import { omitNull, readQuote, type QuoteView } from "./quote-v2-reads";

const invalidState = (status: string) =>
  new QuoteRequestRejected("invalid_state_transition", "The operation is not allowed in the quote's current state.", { status });

/**
 * `POST /v2/quotes/{quoteId}/cancel` — state machine T7 (draft), T8 (issued,
 * before its validity boundary) and T11 (issuing whose current issuance
 * operation `failed`). One transaction, Domain §12 order: binding (replay /
 * conflict) → 404 (missing or not the creator, A4) → 422 body → 409 state →
 * 409 version → transition + audit + binding.
 *
 * The quote row lock serializes cancel against edit, issue, another cancel and
 * any future worker transition (manifest commit and operator retry both update
 * the quote row), so the current operation read under it cannot become active
 * behind our back. Expiry is evaluated with the injected clock at the instant
 * the lock is held: at or after `validUntilExclusive` the quote is effectively
 * `expired` and the cancel is rejected exactly as for a materialized one.
 * Nothing is rendered or rewritten; a number allocated at issue acceptance is
 * kept, and a draft gets none.
 */
export async function cancelQuote(database: PostgresDatabase, quoteId: string, input: DraftCommandInput): Promise<CommandOutcome<QuoteView>> {
  const context = commandContext(input, "quote.cancel", { quoteId });
  const clock = input.clock ?? databaseClock;

  return database.withTransaction(async (client) => {
    const answered = await answerFromBinding(client, context, (bound) => readQuote(client, bound.quoteId, clock));

    if (answered) {
      return answered;
    }

    const locked = await lockOwnQuote(client, quoteId, input.principal);
    const request = parseRequest(cancelRequestSchema, input.body);
    const now = await clock.now(client);
    let operationStatus: string | null = null;

    if (locked.status === "issuing") {
      const { rows } = await client.query<{ status: string }>(
        `select status from quote_service.issuance_operations where operation_id = $1`,
        [locked.current_operation_id]
      );
      operationStatus = rows[0]!.status;

      // Only an operation actually in the terminal `failed` state releases the quote (T11, amendment A1);
      // a passed deadline alone does not.
      if (operationStatus !== "failed") {
        throw new QuoteRequestRejected("operation_in_progress", "The quote is issuing; retry after the operation completes.", {
          operationId: locked.current_operation_id
        });
      }
    } else if (locked.status === "issued") {
      if (isPastValidity(locked.valid_until_exclusive, now)) {
        throw invalidState("expired");
      }
    } else if (locked.status !== "draft") {
      throw invalidState(locked.status);
    }

    if (locked.version !== request.expectedVersion) {
      throw new QuoteRequestRejected("version_conflict", "expectedVersion does not match the current quote version.", {
        expectedVersion: request.expectedVersion,
        currentVersion: locked.version
      });
    }

    await client.query(
      `update quote_service.quotes
       set status = 'cancelled', version = version + 1, cancelled_at = $2, cancellation_reason_code = $3,
           cancellation_initiated_by = $4, updated_at = $2
       where quote_id = $1`,
      [quoteId, now, request.reasonCode, input.principal.principalId]
    );

    // T8: queued email deliveries not yet `sending` never go out for a cancelled quote.
    const failedDeliveryIds =
      locked.status === "issued"
        ? (
            await client.query<{ delivery_id: string }>(
              `update quote_service.quote_deliveries set status = 'failed', last_error_code = 'quote_cancelled', updated_at = $2
               where quote_id = $1 and status = 'pending'
               returning delivery_id`,
              [quoteId, now]
            )
          ).rows
            .map((row) => row.delivery_id)
            .sort()
        : [];

    await appendAudit(client, {
      quoteId,
      type: "quote.cancelled",
      principalId: input.principal.principalId,
      operationId: locked.current_operation_id,
      correlationId: context.correlationId,
      keyHash: context.scope.keyHash,
      fromStatus: locked.status,
      toStatus: "cancelled",
      // Minimal non-PII data (Domain §11): the free-text note stays in the request snapshot only.
      data: omitNull({
        quoteNumber: locked.quote_number,
        reasonCode: request.reasonCode,
        previousVersion: locked.version,
        version: locked.version + 1,
        operationStatus,
        hasNote: request.note !== undefined
      })
    });

    // One `quote.delivery.failed` per delivery failed by T8, in the cancel's
    // transaction: ids and the code only (Domain §11; never the recipient).
    // A replay is answered from the binding above, so these are never repeated.
    for (const deliveryId of failedDeliveryIds) {
      await appendAudit(client, {
        quoteId,
        type: "quote.delivery.failed",
        principalId: input.principal.principalId,
        operationId: null,
        correlationId: context.correlationId,
        keyHash: context.scope.keyHash,
        fromStatus: null,
        toStatus: null,
        data: { deliveryId, errorCode: "quote_cancelled" }
      });
    }

    await bind(client, context, input.body, { quoteId, operationId: null });

    return { kind: "accepted", result: await readQuote(client, quoteId, clock) };
  });
}
