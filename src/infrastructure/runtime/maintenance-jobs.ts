import type { Capability } from "../../application/health/dependency-monitor";
import type { DeliveryQueueMetrics } from "../../application/quote-v2/delivery/delivery-execution";
import type { CommittedArtifactReader } from "../../application/quote-v2/document/artifact-store-port";
import type { LifecycleView, WorkerLogger } from "../../application/quote-v2/issuance-worker";
import { verifyDocumentArtifacts } from "../documents/document-artifact-verifier";
import type { PostgresDatabase } from "../persistence/postgres/postgres";
import { expiryQueueMetrics, materializeExpiredQuotes } from "../persistence/postgres/quote-v2-expiry";
import { PeriodicJobRunner } from "./periodic-job-runner";

/*
 * R1.6D maintenance jobs. Neither owns durable state: every tick asks
 * PostgreSQL (and, for integrity, the artifact store).
 *
 * - `expiry` (T9 materialization): gated on PERSISTENCE only, so a renderer,
 *   storage or email outage never stops it. Bounded batches per tick; stops
 *   between batches on shutdown and resumes idempotently on the next tick or
 *   instance. Each tick refreshes the `workers.expiry` queue metrics.
 * - `documentIntegrity` (Domain §9.4, W7): opt-in, low cadence, gated on
 *   DOCUMENT_READ. A scheduler around the SAME verifier as `documents:verify`
 *   (read only: it never repairs, renders, writes, changes a manifest or a
 *   quote, or deletes). Never affects readiness.
 */

export interface CapabilityGate {
  canRun(capability: Capability): boolean;
}

export interface ExpiryJob {
  readonly runner: PeriodicJobRunner;
  /** Last measured queue metrics (null until the first tick). */
  queueMetrics(): DeliveryQueueMetrics | null;
}

export function createExpiryJob(input: {
  readonly database: Pick<PostgresDatabase, "withTransaction" | "query">;
  readonly intervalMs: number;
  readonly readiness: CapabilityGate;
  readonly lifecycle: LifecycleView;
  readonly logger: WorkerLogger;
  readonly batchSize?: number;
  readonly maxBatchesPerTick?: number;
}): ExpiryJob {
  const batchSize = input.batchSize ?? 100;
  const maxBatches = input.maxBatchesPerTick ?? 10;
  let metrics: DeliveryQueueMetrics | null = null;

  const runner = new PeriodicJobRunner({
    name: "expiry",
    intervalMs: input.intervalMs,
    logger: input.logger,
    canRun: () => input.readiness.canRun("PERSISTENCE"),
    execute: async () => {
      let materialized = 0;

      for (let batch = 0; batch < maxBatches && !input.lifecycle.isShuttingDown; batch += 1) {
        const expired = await materializeExpiredQuotes(input.database, batchSize);
        materialized += expired.length;

        if (expired.length < batchSize) {
          break;
        }
      }

      // One line per tick, never per quote: each quote's durable record is its `quote.expired` audit event.
      if (materialized > 0) {
        input.logger.info({ event: "expiry.materialized", count: materialized }, "Expired quotes materialized");
      }

      metrics = await expiryQueueMetrics(input.database);
    }
  });

  return { runner, queueMetrics: () => metrics };
}

export function createDocumentIntegrityJob(input: {
  readonly database: Pick<PostgresDatabase, "query">;
  readonly store: CommittedArtifactReader;
  readonly intervalMs: number;
  readonly readiness: CapabilityGate;
  readonly logger: WorkerLogger;
  readonly batchSize?: number;
}): PeriodicJobRunner {
  const canRead = () => input.readiness.canRun("DOCUMENT_READ");

  // PeriodicJobRunner is single-flight: a tick never overlaps a running scan in this process.
  return new PeriodicJobRunner({
    name: "documentIntegrity",
    intervalMs: input.intervalMs,
    logger: input.logger,
    canRun: canRead,
    execute: async () => {
      const startedAtMs = Date.now();
      const report = await verifyDocumentArtifacts({
        database: input.database,
        store: input.store,
        recordLegacyByteLength: false,
        ...(input.batchSize ? { batchSize: input.batchSize } : {}),
        // Stop between batches on shutdown or when storage/database becomes unavailable.
        shouldContinue: canRead
      });
      // A scan that lost its dependencies part-way may have read a vanished
      // mount as MISSING: only a scan completed with them still available reports per-artifact problems.
      const completed = report.complete && canRead();

      if (completed) {
        for (const problem of report.problems) {
          // Ids, category and hash only: never a path, a storage key, customer data or bytes.
          input.logger.error(
            {
              event: "document.integrity_failed",
              source: "integrity_scan",
              quoteId: problem.quoteId,
              documentId: problem.documentId,
              origin: problem.origin,
              category: problem.status,
              pdfSha256: problem.pdfSha256
            },
            "Committed document failed scheduled verification"
          );
        }
      }

      const summary = {
        event: "document.integrity_scan_completed",
        completed,
        checked: report.checked,
        ok: report.ok,
        problems: report.problems.length,
        byStatus: report.byStatus,
        durationMs: Date.now() - startedAtMs
      };

      if (completed && report.problems.length === 0) {
        input.logger.info(summary, "Document integrity scan completed");
      } else {
        input.logger.warn(summary, completed ? "Document integrity scan found problems" : "Document integrity scan interrupted");
      }
    }
  });
}
