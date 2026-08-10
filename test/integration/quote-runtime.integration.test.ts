import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createHttpQuoteTestContext,
  MutableClock,
  type HttpQuoteTestContext
} from "../helpers/http-quote-test-context";

interface PublicQuoteDto {
  readonly quoteId: string;
  readonly status: string;
  readonly version: number;
  readonly timestamps: {
    readonly expiredAt: string | null;
  };
  readonly issuedDocument: {
    readonly available: boolean;
  };
}

interface QuoteAuditResponse {
  readonly items: Array<{ action: string; payload: Record<string, unknown> }>;
}

const RUNTIME_INTEGRATION_TEST_TIMEOUT_MS = 60_000;

function buildCreateQuoteBody(validUntil = "2026-08-10T18:30:00.000Z") {
  return {
    opportunityId: "opp-runtime-1",
    customerId: "customer-runtime-1",
    conversationId: "conversation-runtime-1",
    actor: {
      type: "sales_agent" as const,
      id: "agent-runtime-1"
    },
    source: {
      system: "crm_customer_360" as const,
      correlationId: "corr-runtime-1"
    },
    currency: "CLP" as const,
    customerSnapshot: {
      name: "Runtime Test",
      businessName: "Pesas Chile",
      email: "runtime@example.com",
      phone: "12345678",
      address: "Street 1",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        type: "product" as const,
        externalItemId: "sku-runtime-1",
        sku: "SKU-RUNTIME-1",
        description: "Runtime line",
        quantity: "2",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19"
      }
    ],
    validUntil
  };
}

async function createDraft(context: HttpQuoteTestContext, idempotencyKey: string, validUntil?: string) {
  return context.request<PublicQuoteDto>({
    method: "POST",
    path: "/v1/quotes",
    headers: {
      "Idempotency-Key": idempotencyKey
    },
    body: buildCreateQuoteBody(validUntil)
  });
}

async function issueDraft(context: HttpQuoteTestContext, quoteId: string, idempotencyKey: string) {
  return context.request<PublicQuoteDto>({
    method: "POST",
    path: `/v1/quotes/${quoteId}/issue`,
    headers: {
      "Idempotency-Key": idempotencyKey
    },
    body: {
      expectedVersion: 1,
      actor: buildCreateQuoteBody().actor,
      source: buildCreateQuoteBody().source
    }
  });
}

async function getQuote(context: HttpQuoteTestContext, quoteId: string) {
  return context.request<PublicQuoteDto>({
    method: "GET",
    path: `/v1/quotes/${quoteId}`
  });
}

async function getAudit(context: HttpQuoteTestContext, quoteId: string) {
  return context.request<QuoteAuditResponse>({
    method: "GET",
    path: `/v1/quotes/${quoteId}/audit?limit=50&offset=0`
  });
}

async function pollUntil<T>(
  work: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 6_000,
  intervalMs = 200
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const value = await work();

    if (predicate(value)) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function createIssuedQuoteFixture(
  context: HttpQuoteTestContext,
  validUntil = "2026-08-10T18:30:00.000Z"
): Promise<PublicQuoteDto> {
  const draft = await createDraft(context, `create-runtime-${crypto.randomUUID()}`, validUntil);
  const issued = await issueDraft(
    context,
    draft.body!.quoteId,
    `issue-runtime-${crypto.randomUUID()}`
  );

  expect(issued.status).toBe(200);
  return issued.body!;
}

describe("Quote runtime operations", () => {
  it("expires issued quotes through the scheduler job and does not duplicate audit on repeated runs", async () => {
    const clock = new MutableClock("2026-08-10T18:25:00.000Z");
    const context = await createHttpQuoteTestContext({
      clock,
      envOverrides: {
        QUOTE_EXPIRATION_SCHEDULER_ENABLED: true,
        QUOTE_EXPIRATION_INTERVAL_MS: 3_600_000
      }
    });

    try {
      const issued = await createIssuedQuoteFixture(context);

      clock.set("2026-08-10T18:31:00.000Z");
      await context.appContext.backgroundJobs.runExpirationNow();
      await context.appContext.backgroundJobs.runExpirationNow();

      const quote = await getQuote(context, issued.quoteId);
      const audit = await getAudit(context, issued.quoteId);

      expect(quote.body).toMatchObject({
        status: "expired",
        version: 3,
        timestamps: {
          expiredAt: "2026-08-10T18:31:00.000Z"
        }
      });
      expect(audit.body?.items.filter((event) => event.action === "expired")).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps expiration multi-instance safe when two workers run concurrently", async () => {
    const clock = new MutableClock("2026-08-10T18:25:00.000Z");
    const context = await createHttpQuoteTestContext({
      clock,
      envOverrides: {
        QUOTE_EXPIRATION_SCHEDULER_ENABLED: true,
        QUOTE_EXPIRATION_INTERVAL_MS: 3_600_000
      }
    });

    try {
      const issued = await createIssuedQuoteFixture(context);

      clock.set("2026-08-10T18:31:00.000Z");
      await Promise.all([
        context.appContext.backgroundJobs.runExpirationNow(),
        context.appContext.backgroundJobs.runExpirationNow()
      ]);

      const quote = await getQuote(context, issued.quoteId);
      const audit = await getAudit(context, issued.quoteId);

      expect(quote.body?.status).toBe("expired");
      expect(audit.body?.items.filter((event) => event.action === "expired")).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps accept versus expire races in a consistent final state", async () => {
    const clock = new MutableClock("2026-08-10T18:25:00.000Z");
    const context = await createHttpQuoteTestContext({
      clock,
      envOverrides: {
        QUOTE_EXPIRATION_SCHEDULER_ENABLED: true,
        QUOTE_EXPIRATION_INTERVAL_MS: 3_600_000
      }
    });

    try {
      const issued = await createIssuedQuoteFixture(context);

      clock.set("2026-08-10T18:31:00.000Z");
      const [acceptResponse] = await Promise.all([
        context.request<PublicQuoteDto>({
          method: "POST",
          path: `/v1/quotes/${issued.quoteId}/accept`,
          headers: {
            "Idempotency-Key": `accept-race-${crypto.randomUUID()}`
          },
          body: {
            expectedVersion: 2,
            actor: {
              type: "operator",
              id: "operator-race"
            },
            source: {
              system: "manual",
              correlationId: "accept-race"
            }
          }
        }),
        context.appContext.backgroundJobs.runExpirationNow()
      ]);
      const quote = await getQuote(context, issued.quoteId);
      const audit = await getAudit(context, issued.quoteId);
      const terminalActions = audit.body?.items.filter(
        (event) => event.action === "accepted" || event.action === "expired"
      );

      expect([200, 409]).toContain(acceptResponse.status);
      expect(["accepted", "expired"]).toContain(quote.body!.status);
      expect(terminalActions).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("recovers expired quotes after restart when the scheduler is enabled", async () => {
    const initialClock = new MutableClock("2026-08-10T18:25:00.000Z");
    const firstContext = await createHttpQuoteTestContext({
      clock: initialClock,
      preserveDatabaseOnDispose: true,
      preserveStorageOnDispose: true,
      envOverrides: {
        QUOTE_EXPIRATION_SCHEDULER_ENABLED: false
      }
    });
    const sharedDatabaseHandle = firstContext.databaseHandle;
    const sharedStorageRoot = firstContext.storageRoot;

    try {
      const issued = await createIssuedQuoteFixture(firstContext);
      await firstContext.dispose();

      const restartedClock = new MutableClock("2026-08-10T18:31:00.000Z");
      const secondContext = await createHttpQuoteTestContext({
        databaseHandle: sharedDatabaseHandle,
        storageRoot: sharedStorageRoot,
        clock: restartedClock,
        envOverrides: {
          QUOTE_EXPIRATION_SCHEDULER_ENABLED: true,
          QUOTE_EXPIRATION_INTERVAL_MS: 1_000,
          QUOTE_EXPIRATION_BATCH_SIZE: 25
        }
      });

      try {
        const quote = await pollUntil(
          () => getQuote(secondContext, issued.quoteId),
          (response) => response.body?.status === "expired"
        );

        expect(quote.body?.status).toBe("expired");
        expect(quote.body?.timestamps.expiredAt).toBe("2026-08-10T18:31:00.000Z");
      } finally {
        await secondContext.dispose();
      }
    } catch (error) {
      await firstContext.dispose().catch(() => undefined);
      throw error;
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("removes only old orphaned artifacts and preserves live or recent files", async () => {
    const clock = new MutableClock("2026-08-10T18:25:00.000Z");
    const context = await createHttpQuoteTestContext({
      clock,
      envOverrides: {
        QUOTE_DOCUMENT_CLEANUP_ENABLED: true,
        QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS: 3_600_000,
        QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS: 60_000
      }
    });

    try {
      const issued = await createIssuedQuoteFixture(context);
      const liveDocuments = await context.request<{
        readonly available: boolean;
        readonly pdf: { readonly sha256: string | null };
        readonly html: { readonly sha256: string | null };
      }>({
        method: "GET",
        path: `/v1/quotes/${issued.quoteId}/documents`
      });
      const oldOrphanPath = path.join(context.storageRoot, "quotes", "orphan-old", "quote.pdf");
      const recentOrphanPath = path.join(context.storageRoot, "quotes", "orphan-recent", "quote.pdf");

      await fsPromises.mkdir(path.dirname(oldOrphanPath), {
        recursive: true
      });
      await fsPromises.mkdir(path.dirname(recentOrphanPath), {
        recursive: true
      });
      await fsPromises.writeFile(oldOrphanPath, "old orphan", "utf8");
      await fsPromises.writeFile(recentOrphanPath, "recent orphan", "utf8");
      await fsPromises.utimes(
        oldOrphanPath,
        new Date("2026-08-10T18:20:00.000Z"),
        new Date("2026-08-10T18:20:00.000Z")
      );

      clock.set("2026-08-10T18:31:00.000Z");
      await Promise.all([
        context.appContext.backgroundJobs.runCleanupNow(),
        context.appContext.backgroundJobs.runCleanupNow()
      ]);

      expect(await fsPromises.stat(recentOrphanPath)).toBeDefined();
      await expect(fsPromises.access(oldOrphanPath)).rejects.toThrow();
      expect(liveDocuments.body?.available).toBe(true);
    } finally {
      await context.dispose();
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("cleans orphaned artifacts after restart without deleting issued documents", async () => {
    const initialClock = new MutableClock("2026-08-10T18:25:00.000Z");
    const firstContext = await createHttpQuoteTestContext({
      clock: initialClock,
      preserveDatabaseOnDispose: true,
      preserveStorageOnDispose: true,
      envOverrides: {
        QUOTE_DOCUMENT_CLEANUP_ENABLED: false
      }
    });
    const sharedDatabaseHandle = firstContext.databaseHandle;
    const sharedStorageRoot = firstContext.storageRoot;

    try {
      const issued = await createIssuedQuoteFixture(firstContext);
      const orphanPath = path.join(sharedStorageRoot, "quotes", "restart-orphan", "quote.pdf");

      await fsPromises.mkdir(path.dirname(orphanPath), {
        recursive: true
      });
      await fsPromises.writeFile(orphanPath, "restart orphan", "utf8");
      await fsPromises.utimes(
        orphanPath,
        new Date("2026-08-10T18:20:00.000Z"),
        new Date("2026-08-10T18:20:00.000Z")
      );
      await firstContext.dispose();

      const restartedClock = new MutableClock("2026-08-10T18:31:00.000Z");
      const secondContext = await createHttpQuoteTestContext({
        databaseHandle: sharedDatabaseHandle,
        storageRoot: sharedStorageRoot,
        clock: restartedClock,
        envOverrides: {
          QUOTE_DOCUMENT_CLEANUP_ENABLED: true,
          QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS: 1_000,
          QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS: 60_000
        }
      });

      try {
        await pollUntil(
          async () => {
            try {
              await fsPromises.access(orphanPath);
              return false;
            } catch {
              return true;
            }
          },
          (deleted) => deleted
        );

        const quote = await getQuote(secondContext, issued.quoteId);

        expect(quote.body?.status).toBe("issued");
        expect(quote.body?.issuedDocument.available).toBe(true);
      } finally {
        await secondContext.dispose();
      }
    } catch (error) {
      await firstContext.dispose().catch(() => undefined);
      throw error;
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);
});
