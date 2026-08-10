import pg from "pg";
import { describe, expect, it } from "vitest";

import { ApplicationError } from "../../src/application/quote/errors";
import { QuoteService, type CreateDraftQuoteCommand } from "../../src/application/quote/quote-service";
import { PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { PostgresQuoteRepository } from "../../src/infrastructure/persistence/postgres/quote-repository";
import {
  createPostgresQuoteTestContext,
  type PostgresQuoteTestContext
} from "../helpers/postgres-quote-test-context";

const { Client } = pg;
const POSTGRES_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

function buildCreateDraftCommand(
  overrides: Partial<CreateDraftQuoteCommand> = {}
): CreateDraftQuoteCommand {
  return {
    opportunityId: "opp-1",
    customerId: "customer-1",
    conversationId: "conversation-1",
    actor: {
      type: "sales_agent",
      id: "agent-1"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-1"
    },
    currency: "CLP",
    customerSnapshot: {
      name: "Jane Doe",
      businessName: "Pesas Chile",
      email: "jane@example.com",
      phone: "12345678",
      address: "Street 1",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        description: "Line 1",
        type: "product",
        quantity: "1.5",
        unitPrice: "1000",
        taxIncluded: false,
        taxRate: "0.19"
      }
    ],
    validUntil: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-10T00:00:00.000Z",
    idempotencyKey: "idem-create-1",
    ...overrides
  };
}

function buildIssuedDocument() {
  return {
    contentHash: "content-hash-v1",
    renderVersion: "v1",
    pdfStorageKey: "quotes/q-1.pdf",
    pdfSha256: "a".repeat(64),
    htmlStorageKey: "quotes/q-1.html",
    htmlSha256: "b".repeat(64),
    generatedAt: "2026-08-10T02:00:00.000Z"
  };
}

async function withContext(
  work: (context: PostgresQuoteTestContext) => Promise<void>
): Promise<void> {
  const context = await createPostgresQuoteTestContext();

  try {
    await work(context);
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

function expectApplicationError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ApplicationError);
  expect((error as ApplicationError).code).toBe(code);
}

describe("PostgreSQL quote persistence", () => {
  it("persists and rehydrates a quote with exact decimal fidelity", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());
      const byId = await context.service.findById(created.quote.quoteId);
      const byNumber = await context.service.findByQuoteNumber(created.quote.quoteNumber);

      expect(created.quote.pricing).toEqual({
        subtotal: "1500",
        taxAmount: "285",
        total: "1785"
      });
      expect(byId).toEqual(created.quote);
      expect(byNumber).toEqual(created.quote);

      const client = await createClient(context.databaseHandle.connectionString);

      try {
        const lineResult = await client.query<{
          quantity: string;
          unit_price: string;
          tax_rate: string;
        }>(
          `
            select
              quantity::text,
              unit_price::text,
              tax_rate::text
            from quote_service.quote_lines
            where quote_id = $1::uuid
          `,
          [created.quote.quoteId]
        );

        expect(lineResult.rows[0]).toEqual({
          quantity: "1.500000",
          unit_price: "1000",
          tax_rate: "0.190000"
        });
      } finally {
        await client.end();
      }
    });
  }, POSTGRES_INTEGRATION_TEST_TIMEOUT_MS);

  it("generates concurrent-safe monotonic quote numbers", async () => {
    await withContext(async (context) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          context.service.createDraft(
            buildCreateDraftCommand({
              opportunityId: `opp-${index + 1}`,
              idempotencyKey: `idem-number-${index + 1}`
            })
          )
        )
      );

      const numbers = results.map((result) => result.quote.quoteNumber);
      const numericSuffixes = numbers
        .map((number) => Number.parseInt(number.replace("PC-", ""), 10))
        .sort((left, right) => left - right);

      expect(new Set(numbers).size).toBe(8);
      expect(numbers.every((number) => /^PC-\d{6}$/.test(number))).toBe(true);

      for (let index = 1; index < numericSuffixes.length; index += 1) {
        const current = numericSuffixes[index];
        const previous = numericSuffixes[index - 1];

        if (current === undefined || previous === undefined) {
          throw new Error("Expected consecutive numeric suffixes");
        }

        expect(current - previous).toBe(1);
      }
    });
  });

  it("enforces optimistic locking for concurrent writers", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());

      const outcomes = await Promise.allSettled([
        context.service.updateDraft({
          quoteId: created.quote.quoteId,
          expectedVersion: 1,
          customerSnapshot: {
            name: "Jane Update A"
          },
          items: [
            {
              description: "Update A",
              type: "product",
              quantity: "2",
              unitPrice: "1000",
              taxIncluded: false,
              taxRate: "0.19"
            }
          ],
          validUntil: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          actor: created.quote.actor,
          source: created.quote.source,
          idempotencyKey: "idem-update-a"
        }),
        context.service.updateDraft({
          quoteId: created.quote.quoteId,
          expectedVersion: 1,
          customerSnapshot: {
            name: "Jane Update B"
          },
          items: [
            {
              description: "Update B",
              type: "product",
              quantity: "3",
              unitPrice: "1000",
              taxIncluded: false,
              taxRate: "0.19"
            }
          ],
          validUntil: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:01.000Z",
          actor: created.quote.actor,
          source: created.quote.source,
          idempotencyKey: "idem-update-b"
        })
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expectApplicationError(
        (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason,
        "optimistic_concurrency_conflict"
      );

      const persisted = await context.service.findById(created.quote.quoteId);

      expect(persisted?.version).toBe(2);
    });
  });

  it("rolls back the business mutation when audit insert fails", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());
      const client = await createClient(context.databaseHandle.connectionString);

      try {
        await client.query(`
          create or replace function quote_service.fail_draft_updated_audit()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.action = 'draft_updated' then
              raise exception 'audit failure';
            end if;
            return new;
          end;
          $$;
        `);
        await client.query(`
          create trigger fail_draft_updated_audit
          before insert on quote_service.quote_audit_events
          for each row execute function quote_service.fail_draft_updated_audit();
        `);

        await expect(
          context.service.updateDraft({
            quoteId: created.quote.quoteId,
            expectedVersion: 1,
            customerSnapshot: {
              name: "Jane Update"
            },
            items: [
              {
                description: "Audit failure update",
                type: "product",
                quantity: "2",
                unitPrice: "1000",
                taxIncluded: false,
                taxRate: "0.19"
              }
            ],
            validUntil: "2026-08-22T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            actor: created.quote.actor,
            source: created.quote.source,
            idempotencyKey: "idem-audit-failure"
          })
        ).rejects.toThrow("audit failure");

        const persisted = await context.service.findById(created.quote.quoteId);
        const auditEvents = await context.service.listAuditEvents({
          quoteId: created.quote.quoteId,
          limit: 50,
          offset: 0
        });

        expect(persisted?.version).toBe(1);
        expect(persisted?.customerSnapshot.name).toBe("Jane Doe");
        expect(auditEvents.items).toHaveLength(1);
      } finally {
        await client.end();
      }
    });
  });

  it("rolls back the header update when line replacement fails", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());
      const client = await createClient(context.databaseHandle.connectionString);

      try {
        await client.query(`
          create or replace function quote_service.fail_line_insert()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.description = 'Trigger failure' then
              raise exception 'line insert failure';
            end if;
            return new;
          end;
          $$;
        `);
        await client.query(`
          create trigger fail_line_insert
          before insert on quote_service.quote_lines
          for each row execute function quote_service.fail_line_insert();
        `);

        await expect(
          context.service.updateDraft({
            quoteId: created.quote.quoteId,
            expectedVersion: 1,
            customerSnapshot: {
              name: "Jane Update"
            },
            items: [
              {
                description: "Trigger failure",
                type: "product",
                quantity: "2",
                unitPrice: "1000",
                taxIncluded: false,
                taxRate: "0.19"
              }
            ],
            validUntil: "2026-08-22T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            actor: created.quote.actor,
            source: created.quote.source,
            idempotencyKey: "idem-line-failure"
          })
        ).rejects.toThrow("line insert failure");

        const persisted = await context.service.findById(created.quote.quoteId);

        expect(persisted?.version).toBe(1);
        expect(persisted?.items[0]?.description).toBe("Line 1");
      } finally {
        await client.end();
      }
    });
  });

  it("replays completed idempotent requests and rejects same key with different payload", async () => {
    await withContext(async (context) => {
      const command = buildCreateDraftCommand();
      const created = await context.service.createDraft(command);
      const replayed = await context.service.createDraft(command);

      expect(replayed).toEqual(created);

      const client = await createClient(context.databaseHandle.connectionString);

      try {
        const countResult = await client.query<{ count: string }>(
          "select count(*)::text as count from quote_service.quotes"
        );
        expect(countResult.rows[0]?.count).toBe("1");
      } finally {
        await client.end();
      }

      await expect(
        context.service.createDraft(
          buildCreateDraftCommand({
            customerSnapshot: {
              name: "Changed Name"
            }
          })
        )
      ).rejects.toMatchObject({
        code: "idempotency_key_reused_with_different_payload"
      });
    });
  });

  it("allows only one in-flight effect for concurrent same-key requests", async () => {
    await withContext(async (context) => {
      const command = buildCreateDraftCommand({
        idempotencyKey: "idem-concurrent-same-key"
      });

      const [first, second] = await Promise.all([
        context.service.createDraft(command),
        context.service.createDraft(command)
      ]);

      expect(first).toEqual(second);

      const client = await createClient(context.databaseHandle.connectionString);

      try {
        const countResult = await client.query<{ count: string }>(
          "select count(*)::text as count from quote_service.quotes"
        );
        expect(countResult.rows[0]?.count).toBe("1");
      } finally {
        await client.end();
      }
    });
  });

  it("persists revisions atomically with predecessor linkage", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());
      const issued = await context.service.issueQuote({
        quoteId: created.quote.quoteId,
        expectedVersion: 1,
        issuedDocument: buildIssuedDocument(),
        issuedAt: "2026-08-10T03:00:00.000Z",
        actor: created.quote.actor,
        source: created.quote.source,
        idempotencyKey: "idem-issue-1"
      });

      const revision = await context.service.createRevision({
        quoteId: issued.quote.quoteId,
        expectedVersion: 2,
        createdAt: "2026-08-12T00:00:00.000Z",
        validUntil: "2026-08-25T00:00:00.000Z",
        actor: {
          type: "operator",
          id: "operator-1"
        },
        source: {
          system: "manual",
          correlationId: "corr-2"
        },
        idempotencyKey: "idem-revision-1"
      });

      const predecessor = await context.service.findById(issued.quote.quoteId);
      const persistedRevision = await context.service.findById(revision.quote.quoteId);
      const predecessorAudit = await context.service.listAuditEvents({
        quoteId: issued.quote.quoteId,
        limit: 50,
        offset: 0
      });

      expect(predecessor?.supersededByQuoteId).toBe(revision.quote.quoteId);
      expect(predecessor?.version).toBe(3);
      expect(persistedRevision?.status).toBe("draft");
      expect(persistedRevision?.previousRevisionId).toBe(issued.quote.quoteId);
      expect(predecessorAudit.items.some((event) => event.action === "revision_created")).toBe(
        true
      );
    });
  });

  it("allows only one successful concurrent revision for the same predecessor", async () => {
    await withContext(async (context) => {
      const created = await context.service.createDraft(buildCreateDraftCommand());
      await context.service.issueQuote({
        quoteId: created.quote.quoteId,
        expectedVersion: 1,
        issuedDocument: buildIssuedDocument(),
        issuedAt: "2026-08-10T03:00:00.000Z",
        actor: created.quote.actor,
        source: created.quote.source,
        idempotencyKey: "idem-issue-1"
      });

      const outcomes = await Promise.allSettled([
        context.service.createRevision({
          quoteId: created.quote.quoteId,
          expectedVersion: 2,
          createdAt: "2026-08-12T00:00:00.000Z",
          actor: {
            type: "operator",
            id: "operator-1"
          },
          source: {
            system: "manual",
            correlationId: "corr-2"
          },
          idempotencyKey: "idem-revision-a"
        }),
        context.service.createRevision({
          quoteId: created.quote.quoteId,
          expectedVersion: 2,
          createdAt: "2026-08-12T00:00:01.000Z",
          actor: {
            type: "operator",
            id: "operator-2"
          },
          source: {
            system: "manual",
            correlationId: "corr-3"
          },
          idempotencyKey: "idem-revision-b"
        })
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected"
      ) as PromiseRejectedResult;

      expect(rejected.reason).toBeInstanceOf(ApplicationError);
      expect(["optimistic_concurrency_conflict", "quote_already_superseded"]).toContain(
        (rejected.reason as ApplicationError).code
      );

      const client = await createClient(context.databaseHandle.connectionString);

      try {
        const countResult = await client.query<{ count: string }>(
          `
            select count(*)::text as count
            from quote_service.quotes
            where supersedes_quote_id = $1::uuid
          `,
          [created.quote.quoteId]
        );

        expect(countResult.rows[0]?.count).toBe("1");
      } finally {
        await client.end();
      }
    });
  });

  it("replays idempotent results after restarting the persistence layer", async () => {
    const context = await createPostgresQuoteTestContext();

    try {
      const command = buildCreateDraftCommand({
        idempotencyKey: "idem-restart"
      });
      const created = await context.service.createDraft(command);
      const connectionString = context.databaseHandle.connectionString;

      await context.database.close();

      const restartedDatabase = new PostgresDatabase({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: 0,
        LOG_LEVEL: "silent",
        DATABASE_URL: connectionString,
        DATABASE_SSL_MODE: "disable",
        SERVICE_NAME: "pesaschile-quote-service",
        SERVICE_VERSION: "0.1.0-test",
        SERVICE_AUTH_TOKEN: "token",
        HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000,
        QUOTE_COMPANY_NAME: "Pesas Chile SPA",
        QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
        QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
        QUOTE_RENDER_VERSION: "quote-v1",
        QUOTE_PDF_RENDER_TIMEOUT_MS: 15000
      });
      const restartedService = new QuoteService(
        new PostgresQuoteRepository(restartedDatabase)
      );

      try {
        const replayed = await restartedService.createDraft(command);
        const recovered = await restartedService.findById(created.quote.quoteId);
        const auditEvents = await restartedService.listAuditEvents({
          quoteId: created.quote.quoteId,
          limit: 50,
          offset: 0
        });

        expect(replayed).toEqual(created);
        expect(recovered).toEqual(created.quote);
        expect(auditEvents.items).toHaveLength(1);
      } finally {
        await restartedDatabase.close();
      }
    } finally {
      await context.databaseHandle.dispose();
    }
  });
});
