import pg from "pg";
import { describe, expect, it } from "vitest";

import { QuoteDeliveryService } from "../../src/application/quote-delivery/quote-delivery-service";
import { PostgresQuoteDeliveryRepository } from "../../src/infrastructure/persistence/postgres/quote-delivery-repository";
import {
  createPostgresQuoteTestContext,
  type PostgresQuoteTestContext
} from "../helpers/postgres-quote-test-context";

const { Client } = pg;
const POSTGRES_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

async function withContext(
  work: (
    context: PostgresQuoteTestContext,
    deliveryService: QuoteDeliveryService
  ) => Promise<void>
): Promise<void> {
  const context = await createPostgresQuoteTestContext();
  const deliveryService = new QuoteDeliveryService(
    new PostgresQuoteDeliveryRepository(context.database),
    true
  );

  try {
    await work(context, deliveryService);
  } finally {
    await context.dispose();
  }
}

async function createClient(connectionString: string): Promise<pg.Client> {
  const client = new Client({
    connectionString
  });

  await client.connect();
  return client;
}

async function createIssuedQuote(context: PostgresQuoteTestContext) {
  const created = await context.service.createDraft({
    opportunityId: "opp-email-persistence",
    customerId: "customer-email-persistence",
    conversationId: "conversation-email-persistence",
    actor: {
      type: "sales_agent",
      id: "agent-email-persistence"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-email-persistence"
    },
    currency: "CLP",
    customerSnapshot: {
      name: "Persistence User",
      email: "buyer@example.com"
    },
    items: [
      {
        description: "Platform scale",
        type: "product",
        quantity: "1",
        unitPrice: "100000",
        taxIncluded: false,
        taxRate: "0.19"
      }
    ],
    validUntil: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-12T10:00:00.000Z",
    idempotencyKey: "idem-email-persistence-create"
  });

  const issued = await context.service.issueQuote({
    quoteId: created.quote.quoteId,
    expectedVersion: 1,
    actor: created.quote.actor,
    source: created.quote.source,
    issuedAt: "2026-08-12T10:10:00.000Z",
    idempotencyKey: "idem-email-persistence-issue",
    issuedDocument: {
      contentHash: "content-hash-email-persistence",
      renderVersion: "quote-v1",
      pdfStorageKey: "quotes/persistence/quote.pdf",
      pdfSha256: "a".repeat(64),
      htmlStorageKey: "quotes/persistence/quote.html",
      htmlSha256: "b".repeat(64),
      generatedAt: "2026-08-12T10:10:00.000Z"
    }
  });

  return issued.quote;
}

describe("quote email persistence", () => {
  it("persists the delivery request, outbox row, audit, and idempotent replay", async () => {
    await withContext(async (context, deliveryService) => {
      const quote = await createIssuedQuote(context);

      const first = await deliveryService.requestQuoteEmailDelivery({
        quoteId: quote.quoteId,
        actor: {
          type: "sales_agent",
          id: "agent-email-persistence"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-email-send"
        },
        requestedAt: "2026-08-12T10:20:00.000Z",
        idempotencyKey: "idem-email-delivery-request"
      });
      const replay = await deliveryService.requestQuoteEmailDelivery({
        quoteId: quote.quoteId,
        actor: {
          type: "sales_agent",
          id: "agent-email-persistence"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-email-send"
        },
        requestedAt: "2026-08-12T10:20:00.000Z",
        idempotencyKey: "idem-email-delivery-request"
      });

      expect(replay).toEqual(first);
      expect(first.delivery.status).toBe("pending");
      expect(first.delivery.recipient).toBe("buyer@example.com");

      const audit = await context.service.listAuditEvents({
        quoteId: quote.quoteId,
        limit: 50,
        offset: 0
      });
      const client = await createClient(context.databaseHandle.connectionString);

      try {
        const deliveryResult = await client.query<{
          count: string;
          recipient: string;
          status: string;
        }>(
          `
            select
              count(*) over()::text as count,
              recipient,
              status
            from quote_service.quote_deliveries
            where quote_id = $1::uuid
          `,
          [quote.quoteId]
        );
        const outboxResult = await client.query<{
          count: string;
          status: string;
          attempt_count: number;
        }>(
          `
            select
              count(*) over()::text as count,
              status,
              attempt_count
            from quote_service.quote_email_outbox
            where quote_id = $1::uuid
          `,
          [quote.quoteId]
        );

        expect(deliveryResult.rows[0]?.count).toBe("1");
        expect(deliveryResult.rows[0]?.recipient).toBe("buyer@example.com");
        expect(deliveryResult.rows[0]?.status).toBe("pending");
        expect(outboxResult.rows[0]?.count).toBe("1");
        expect(outboxResult.rows[0]?.status).toBe("pending");
        expect(outboxResult.rows[0]?.attempt_count).toBe(0);
      } finally {
        await client.end();
      }

      expect(audit.items.some((event) => event.action === "email_delivery_requested")).toBe(true);
      expect((await context.service.findById(quote.quoteId))?.status).toBe("issued");
    });
  }, POSTGRES_INTEGRATION_TEST_TIMEOUT_MS);
});
