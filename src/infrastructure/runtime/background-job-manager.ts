import type { QuoteService } from "../../application/quote/quote-service";
import type { ClockPort } from "../../application/ports/clock-port";
import type { AppEnv } from "../config/env";
import type { PostgresDatabase } from "../persistence/postgres/postgres";
import type { OrphanDocumentCleanupService } from "../documents/orphan-document-cleanup-service";
import { PeriodicJobRunner } from "./periodic-job-runner";

const DOCUMENT_CLEANUP_LOCK_KEY = 4_204_001;

type Logger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

export class BackgroundJobManager {
  private readonly expirationRunner: PeriodicJobRunner | null;
  private readonly cleanupRunner: PeriodicJobRunner | null;

  constructor(input: {
    readonly env: AppEnv;
    readonly clock: ClockPort;
    readonly quoteService: QuoteService;
    readonly cleanupService: OrphanDocumentCleanupService;
    readonly database: PostgresDatabase;
    readonly logger: Logger;
  }) {
    this.expirationRunner = input.env.QUOTE_EXPIRATION_SCHEDULER_ENABLED
      ? new PeriodicJobRunner({
          name: "quote-expiration",
          intervalMs: input.env.QUOTE_EXPIRATION_INTERVAL_MS,
          logger: input.logger,
          execute: async () => {
            const now = input.clock.now().toISOString();
            const result = await input.quoteService.expireQuotesBatch({
              now,
              limit: input.env.QUOTE_EXPIRATION_BATCH_SIZE,
              actor: {
                type: "service",
                id: "quote-expiration-scheduler"
              },
              source: {
                system: "scheduler",
                correlationId: null
              }
            });

            input.logger.info(
              {
                job: "quote-expiration",
                processedCount: result.processedCount,
                quoteIds: result.quoteIds
              },
              "Expiration iteration completed"
            );
          }
        })
      : null;
    this.cleanupRunner = input.env.QUOTE_DOCUMENT_CLEANUP_ENABLED
      ? new PeriodicJobRunner({
          name: "document-cleanup",
          intervalMs: input.env.QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS,
          logger: input.logger,
          execute: async () => {
            const lock = await input.database.withAdvisoryLock(DOCUMENT_CLEANUP_LOCK_KEY, async () =>
              input.cleanupService.cleanupOrphans({
                now: input.clock.now().toISOString(),
                minAgeMs: input.env.QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS
              })
            );

            if (!lock.acquired) {
              input.logger.warn(
                {
                  job: "document-cleanup"
                },
                "Cleanup iteration skipped because another instance holds the lock"
              );
              return;
            }

            input.logger.info(
              {
                job: "document-cleanup",
                scannedCount: lock.result?.scannedCount ?? 0,
                deletedCount: lock.result?.deletedCount ?? 0,
                protectedCount: lock.result?.protectedCount ?? 0
              },
              "Document cleanup iteration completed"
            );
          }
        })
      : null;
  }

  start(): void {
    this.expirationRunner?.start();
    this.cleanupRunner?.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.expirationRunner?.stop(), this.cleanupRunner?.stop()]);
  }

  async runExpirationNow(): Promise<void> {
    await this.expirationRunner?.runNow();
  }

  async runCleanupNow(): Promise<void> {
    await this.cleanupRunner?.runNow();
  }
}
