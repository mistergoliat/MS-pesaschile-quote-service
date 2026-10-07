import { OPERATOR_REASON_CODE_PATTERN, type IssuanceOperationRepository } from "../../application/quote-v2/issuance-operation";
import { SnapshotIntegrityError } from "../../application/quote-v2/issued-snapshot";
import type { PrincipalRegistry } from "../auth/principal-registry";
import { loadVerifiedIssuedSnapshot } from "../persistence/postgres/issued-snapshot-loader";
import type { PostgresDatabase } from "../persistence/postgres/postgres";
import { OPERATOR_EXIT, operatorRejected, resolveOperatorPrincipal, type OperatorResult } from "./operator-plane";

/*
 * issuance:retry (R1.6C, pre-flight §17): the operator invocation of T10.
 * The state transition is NOT implemented here: it is
 * PostgresIssuanceOperationRepository.createOperatorRetry, which re-checks
 * everything under the quote lock (quote `issuing`, the named operation is
 * the current one and `failed`, snapshot hash), serializes against T11 and
 * reconciles an unknown COMMIT from durable state. This module only adds the
 * operator-plane rules around it:
 *
 * - W6: the operator must be a registered `operator` principal;
 * - a machine-readable reasonCode (audit `data.reasonCode`, never free text);
 * - the failed operation is named explicitly (no "whatever is current");
 * - without `confirm` it is a read-only dry run that reports the plan;
 * - no idempotency key: a second run with the same failed operation finds it
 *   no longer current and is "not applicable", creating nothing.
 */

export interface IssuanceRetryInput {
  readonly quoteId: string;
  readonly failedOperationId: string;
  readonly operatorPrincipalId: string;
  readonly reasonCode: string;
  /** False: dry run (reads only). True: perform T10. */
  readonly confirm: boolean;
}

export interface IssuanceRetryDependencies {
  readonly database: Pick<PostgresDatabase, "query" | "withTransaction">;
  readonly repository: Pick<IssuanceOperationRepository, "createOperatorRetry">;
  readonly operators: Pick<PrincipalRegistry, "find">;
}

interface RetryStateRow {
  quote_status: string;
  quote_number: string | null;
  version: number;
  current_operation_id: string | null;
  operation_status: string | null;
  last_error_code: string | null;
}

const notApplicable = (body: Record<string, unknown>): OperatorResult => ({
  exitCode: OPERATOR_EXIT.NOT_APPLICABLE,
  body: { status: "not_applicable", ...body }
});

const integrityRefusal = (input: IssuanceRetryInput): OperatorResult => ({
  exitCode: OPERATOR_EXIT.REFUSED,
  body: { status: "refused", reason: "SNAPSHOT_INTEGRITY", quoteId: input.quoteId, failedOperationId: input.failedOperationId }
});

export async function retryFailedIssuance(dependencies: IssuanceRetryDependencies, input: IssuanceRetryInput): Promise<OperatorResult> {
  const operator = resolveOperatorPrincipal(dependencies.operators, input.operatorPrincipalId);

  if (!operator.ok) {
    return operatorRejected(operator.reason);
  }

  if (!OPERATOR_REASON_CODE_PATTERN.test(input.reasonCode)) {
    return { exitCode: OPERATOR_EXIT.REFUSED, body: { status: "refused", reason: "REASON_CODE_INVALID" } };
  }

  // Pre-check (read only): what the operator is about to retry, and whether
  // T10 applies at all. The primitive re-checks all of it under the lock.
  const { rows } = await dependencies.database.query<RetryStateRow>(
    `select q.status as quote_status, q.quote_number, q.version, q.current_operation_id,
            o.status as operation_status, o.last_error_code
     from quote_service.quotes q
     left join quote_service.issuance_operations o on o.operation_id = q.current_operation_id
     where q.quote_id = $1`,
    [input.quoteId]
  );
  const state = rows[0];

  if (!state) {
    return notApplicable({ reason: "QUOTE_NOT_FOUND", quoteId: input.quoteId });
  }

  if (state.quote_status !== "issuing" || state.current_operation_id !== input.failedOperationId || state.operation_status !== "failed") {
    return notApplicable({
      reason: "INVALID_STATE",
      quoteId: input.quoteId,
      failedOperationId: input.failedOperationId,
      quoteStatus: state.quote_status,
      currentOperationId: state.current_operation_id,
      currentOperationStatus: state.operation_status
    });
  }

  // The frozen snapshot must still hash to what was accepted.
  try {
    await dependencies.database.withTransaction(async (client) => {
      await client.query("set transaction isolation level repeatable read, read only");
      await loadVerifiedIssuedSnapshot(client, input.failedOperationId);
    });
  } catch (error) {
    if (error instanceof SnapshotIntegrityError) {
      return integrityRefusal(input);
    }

    throw error;
  }

  const plan = {
    quoteId: input.quoteId,
    quoteNumber: state.quote_number,
    failedOperationId: input.failedOperationId,
    lastErrorCode: state.last_error_code,
    operatorPrincipalId: operator.principalId,
    reasonCode: input.reasonCode
  };

  if (!input.confirm) {
    return {
      exitCode: OPERATOR_EXIT.OK,
      body: { status: "dry_run", dryRun: true, action: "operator_retry", ...plan, version: state.version, versionAfter: state.version + 1 }
    };
  }

  let result;

  try {
    result = await dependencies.repository.createOperatorRetry({
      quoteId: input.quoteId,
      failedOperationId: input.failedOperationId,
      actorPrincipalId: operator.principalId,
      reasonCode: input.reasonCode,
      correlationId: null
    });
  } catch (error) {
    if (error instanceof SnapshotIntegrityError) {
      return integrityRefusal(input);
    }

    throw error;
  }

  switch (result.kind) {
    case "RETRY_CREATED":
      return {
        exitCode: OPERATOR_EXIT.OK,
        body: { status: "retry_created", dryRun: false, ...plan, newOperationId: result.operationId, deadlineAt: result.deadlineAt.toISOString() }
      };
    case "QUOTE_NOT_FOUND":
      return notApplicable({ reason: "QUOTE_NOT_FOUND", quoteId: input.quoteId });
    case "INVALID_STATE":
      // Lost a race (another retry, a cancel) between the pre-check and the lock.
      return notApplicable({
        reason: "INVALID_STATE",
        quoteId: input.quoteId,
        failedOperationId: input.failedOperationId,
        quoteStatus: result.quoteStatus,
        currentOperationId: result.currentOperationId,
        currentOperationStatus: result.currentOperationStatus
      });
    case "NOT_APPLIED":
      // COMMIT outcome was unknown and durable state proves the retry is not
      // there. Nothing is retried automatically: the operator re-runs
      // issuance:failed and decides.
      return { exitCode: OPERATOR_EXIT.FAILED, body: { status: "not_applied", ...plan } };
  }
}
