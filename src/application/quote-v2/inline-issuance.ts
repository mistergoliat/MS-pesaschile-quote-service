import type { IssuanceWorker, WorkerLogger } from "./issuance-worker";
import { safeErrorSummary } from "../safe-error";

/*
 * Bounded inline issuance (Idempotency §4.4, amendment A2). After an
 * acceptance transaction commits, the request handler gives formal issuance
 * up to `syncIssueBudgetMs` before it answers:
 *
 * - it tries to run the operation itself, through the worker's single
 *   per-process slot and the normal claim/fence rules (no in-memory
 *   ownership: if the periodic worker or another process claimed it first,
 *   the claim simply fails);
 * - otherwise it observes durable state until the operation is no longer
 *   active or the budget runs out.
 *
 * It never decides the response itself: the route re-reads the quote and
 * operation afterwards and answers 201/200 only if the manifest committed
 * (quote `issued`), else 202. An attempt still running when the budget ends
 * keeps running under its lease (the response does not cancel it); shutdown
 * aborts it through the worker like any other attempt.
 */

export interface InlineIssuanceDependencies {
  readonly worker: Pick<IssuanceWorker, "runOperation">;
  /** Full issuance readiness (database, schema, storage, renderer, lifecycle). */
  readonly readiness: { isReady(): boolean };
  /** True while the operation is `pending` or `running` (durable read). */
  readonly isOperationActive: (operationId: string) => Promise<boolean>;
  readonly syncBudgetMs: number;
  readonly logger: WorkerLogger;
  /** Durable-state polling cadence while another holder runs the attempt. */
  readonly observeIntervalMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export class InlineIssuance {
  constructor(private readonly dependencies: InlineIssuanceDependencies) {}

  get budgetMs(): number {
    return this.dependencies.syncBudgetMs;
  }

  /** Spends at most the sync budget trying to get the operation issued. Never throws. */
  async drive(operationId: string, correlationId: string | null): Promise<void> {
    const { worker, readiness, isOperationActive, syncBudgetMs, logger } = this.dependencies;

    if (syncBudgetMs <= 0 || !readiness.isReady()) {
      return;
    }

    const deadline = Date.now() + syncBudgetMs;
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<"budget">((resolve) => {
      budgetTimer = setTimeout(() => resolve("budget"), syncBudgetMs);
      budgetTimer.unref();
    });
    const run = worker.runOperation(operationId, correlationId).catch((error: unknown) => {
      logger.error({ event: "issuance.inline_failed", operationId, ...safeErrorSummary(error) }, "Inline issuance attempt failed");
      return { kind: "busy" } as const;
    });

    try {
      const first = await Promise.race([run, budget]);

      if (first === "budget" || first.kind === "ran") {
        return;
      }

      // Another holder (periodic worker, another process, or a busy slot): observe durable state.
      const interval = this.dependencies.observeIntervalMs ?? 100;

      while (Date.now() < deadline) {
        if (!(await isOperationActive(operationId).catch(() => true))) {
          return;
        }

        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      }
    } finally {
      clearTimeout(budgetTimer);
    }
  }
}
