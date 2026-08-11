import { describe, expect, it } from "vitest";

import { createCanonicalRequestHash } from "../../src/application/quote/canonical-json";
import type { CreateDraftQuoteCommand } from "../../src/application/quote/quote-service";
import {
  createHttpQuoteTestContext,
  type HttpQuoteTestContext
} from "../helpers/http-quote-test-context";

type CreateQuoteHttpBody = Omit<
  CreateDraftQuoteCommand,
  "createdAt" | "idempotencyKey" | "requestHashPayload"
>;

interface PublicQuoteDto {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly items: Array<{ lineId: string; unitPrice: string; taxRate: string }>;
  readonly pricing: { subtotal: string; taxAmount: string; total: string };
  readonly issuedDocument: {
    readonly available: boolean;
    readonly contentHash?: string | null;
    readonly renderVersion?: string | null;
    readonly generatedAt?: string | null;
    readonly pdf?: {
      readonly documentRef: string | null;
      readonly sha256: string | null;
    };
    readonly html?: {
      readonly documentRef: string | null;
      readonly sha256: string | null;
    };
  };
  readonly status: string;
  readonly version: number;
  readonly revision: { rootId: string };
}

interface PublicIssuedDocumentDto {
  readonly available: boolean;
  readonly contentHash: string | null;
  readonly renderVersion: string | null;
  readonly generatedAt: string | null;
  readonly pdf: {
    readonly documentRef: string | null;
    readonly sha256: string | null;
  };
  readonly html: {
    readonly documentRef: string | null;
    readonly sha256: string | null;
  };
}

interface QuoteListResponse {
  readonly items: PublicQuoteDto[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly count: number;
  };
}

interface QuoteAuditResponse {
  readonly items: Array<{ action: string; payload: Record<string, unknown> }>;
}

const HTTP_INTEGRATION_TEST_TIMEOUT_MS = 30_000;
let fixtureSequence = 0;

function nextFixtureIdempotencyKey(prefix: string): string {
  fixtureSequence += 1;
  return `${prefix}-${fixtureSequence}`;
}

function buildCreateQuoteBody(): CreateQuoteHttpBody {
  return {
    opportunityId: "opp-http-1",
    customerId: "customer-http-1",
    conversationId: "conversation-http-1",
    actor: {
      type: "sales_agent",
      id: "agent-http-1"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-http-1"
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
        type: "product",
        externalItemId: "sku-1",
        sku: "SKU-1",
        description: "Line 1",
        quantity: "2",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19"
      }
    ],
    validUntil: "2026-08-20T00:00:00.000Z"
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
    generatedAt: "2026-08-10T20:00:00.000Z"
  };
}

async function withContext(
  work: (context: HttpQuoteTestContext) => Promise<void>
): Promise<void> {
  const context = await createHttpQuoteTestContext();

  try {
    await work(context);
  } finally {
    await context.dispose();
  }
}

async function createDraftViaHttp(
  context: HttpQuoteTestContext,
  overrides: Record<string, unknown> = {},
  idempotencyKey = "create-http-1"
) {
  return context.request<PublicQuoteDto>({
    method: "POST",
    path: "/v1/quotes",
    headers: {
      "Idempotency-Key": idempotencyKey
    },
    body: {
      ...buildCreateQuoteBody(),
      ...overrides
    }
  });
}

async function createIssuedFixture(context: HttpQuoteTestContext) {
  const draft = await context.appContext.quoteService.createDraft({
    ...buildCreateQuoteBody(),
    createdAt: "2026-08-10T18:25:00.000Z",
    idempotencyKey: nextFixtureIdempotencyKey("fixture-draft-issued")
  });

  return context.appContext.quoteService.issueQuote({
    quoteId: draft.quote.quoteId,
    expectedVersion: 1,
    actor: draft.quote.actor,
    source: draft.quote.source,
    idempotencyKey: nextFixtureIdempotencyKey("fixture-issue-issued"),
    issuedAt: "2026-08-10T18:26:00.000Z",
    issuedDocument: buildIssuedDocument()
  });
}

async function createAcceptedFixture(context: HttpQuoteTestContext) {
  const issued = await createIssuedFixture(context);

  return context.appContext.quoteService.acceptQuote({
    quoteId: issued.quote.quoteId,
    expectedVersion: 2,
    actor: issued.quote.actor,
    source: issued.quote.source,
    idempotencyKey: "fixture-accept",
    acceptedAt: "2026-08-10T18:27:00.000Z"
  });
}

describe("Quote HTTP API", () => {
  it("keeps /health public and rejects quote routes without valid auth", async () => {
    await withContext(async (context) => {
      const health = await context.request({
        method: "GET",
        path: "/health",
        auth: "none"
      });
      const missingAuth = await context.request({
        method: "GET",
        path: "/v1/quotes",
        auth: "none"
      });
      const invalidAuth = await context.request({
        method: "GET",
        path: "/v1/quotes",
        auth: "invalid"
      });

      expect(health.status).toBe(200);
      expect(missingAuth).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "missing_authentication"
          }
        }
      });
      expect(invalidAuth).toMatchObject({
        status: 401,
        body: {
          error: {
            code: "invalid_authentication"
          }
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("creates a quote with server-generated ids, money strings, audit, and persistence", async () => {
    await withContext(async (context) => {
      const response = await createDraftViaHttp(context);

      expect(response.status).toBe(201);
      expect(typeof response.body?.quoteId).toBe("string");
      expect(response.body?.quoteNumber).toMatch(/^PC-\d{6}$/);
      expect(response.body?.status).toBe("draft");
      expect(response.body?.version).toBe(1);
      expect(response.body?.pricing).toEqual({
        subtotal: "8387",
        taxAmount: "1593",
        total: "9980"
      });
      expect(response.body?.issuedDocument).toMatchObject({
        available: false
      });
      expect(typeof response.body?.items[0]?.lineId).toBe("string");
      expect(response.body?.items[0]?.unitPrice).toBe("4990");
      expect(response.body?.items[0]?.taxRate).toBe("0.19");

      const stored = await context.appContext.quoteService.findById(response.body!.quoteId);
      const audit = await context.appContext.quoteService.listAuditEvents({
        quoteId: response.body!.quoteId,
        limit: 50,
        offset: 0
      });

      expect(stored?.quoteNumber).toBe(response.body?.quoteNumber);
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]?.action).toBe("draft_created");
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("replays idempotent create requests and rejects same key with different payload", async () => {
    await withContext(async (context) => {
      const first = await createDraftViaHttp(context, {}, "same-key");
      const replay = await createDraftViaHttp(context, {}, "same-key");
      const conflict = await createDraftViaHttp(
        context,
        {
          customerSnapshot: {
            ...buildCreateQuoteBody().customerSnapshot,
            name: "Other Name"
          }
        },
        "same-key"
      );

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(conflict).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "idempotency_key_reused_with_different_payload"
          }
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("validates request shape, ids, decimals, line count, and missing idempotency", async () => {
    await withContext(async (context) => {
      const missingIdempotency = await context.request({
        method: "POST",
        path: "/v1/quotes",
        body: buildCreateQuoteBody()
      });
      const invalidDecimal = await context.request({
        method: "POST",
        path: "/v1/quotes",
        headers: {
          "Idempotency-Key": "invalid-decimal"
        },
        body: {
          ...buildCreateQuoteBody(),
          items: [
            {
              ...buildCreateQuoteBody().items[0],
              quantity: 2
            }
          ]
        }
      });
      const tooManyLines = await context.request({
        method: "POST",
        path: "/v1/quotes",
        headers: {
          "Idempotency-Key": "too-many-lines"
        },
        body: {
          ...buildCreateQuoteBody(),
          items: Array.from({ length: 101 }, (_, index) => ({
            ...buildCreateQuoteBody().items[0],
            description: `Line ${index}`
          }))
        }
      });
      const invalidUuid = await context.request({
        method: "GET",
        path: "/v1/quotes/not-a-uuid"
      });

      expect(missingIdempotency.status).toBe(400);
      expect(missingIdempotency.body).toMatchObject({
        error: {
          code: "validation_error"
        }
      });
      expect(invalidDecimal.body).toMatchObject({
        error: {
          code: "invalid_line_quantity"
        }
      });
      expect(tooManyLines.status).toBe(400);
      expect(invalidUuid.body).toMatchObject({
        error: {
          code: "invalid_quote_reference"
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("enforces the configured HTTP body limit", async () => {
    const context = await createHttpQuoteTestContext({
      envOverrides: {
        HTTP_BODY_LIMIT_BYTES: 1_024
      }
    });

    try {
      const response = await context.requestRaw({
        method: "POST",
        path: "/v1/quotes",
        headers: {
          "Idempotency-Key": "body-too-large"
        },
        body: {
          ...buildCreateQuoteBody(),
          customerSnapshot: {
            ...buildCreateQuoteBody().customerSnapshot,
            address: "X".repeat(5_000)
          }
        }
      });

      expect(response.status).toBe(413);
      expect(response.bodyText).toContain("Request body is too large");
    } finally {
      await context.dispose();
    }
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("reads quotes by id and by number and exposes documents safely", async () => {
    await withContext(async (context) => {
      const created = await createDraftViaHttp(context);
      const byId = await context.request({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}`
      });
      const byNumber = await context.request({
        method: "GET",
        path: `/v1/quotes/by-number/${created.body!.quoteNumber}`
      });
      const documents = await context.request<PublicIssuedDocumentDto>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/documents`
      });
      const missing = await context.request({
        method: "GET",
        path: `/v1/quotes/${crypto.randomUUID()}`
      });

      expect(byId.status).toBe(200);
      expect(byNumber.status).toBe(200);
      expect(byId.body).toEqual(byNumber.body);
      expect(documents.body).toEqual({
        available: false,
        contentHash: null,
        renderVersion: null,
        generatedAt: null,
        pdf: {
          documentRef: null,
          sha256: null
        },
        html: {
          documentRef: null,
          sha256: null
        }
      });
      expect(missing).toMatchObject({
        status: 404,
        body: {
          error: {
            code: "quote_not_found"
          }
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("updates drafts, enforces optimistic concurrency, and rejects editing non-drafts", async () => {
    await withContext(async (context) => {
      const created = await createDraftViaHttp(context);
      const updated = await context.request({
        method: "PUT",
        path: `/v1/quotes/${created.body!.quoteId}/draft`,
        headers: {
          "Idempotency-Key": "update-draft-1"
        },
        body: {
          expectedVersion: 1,
          actor: buildCreateQuoteBody().actor,
          source: buildCreateQuoteBody().source,
          customerSnapshot: {
            ...buildCreateQuoteBody().customerSnapshot,
            name: "Updated Name"
          },
          items: [
            {
              ...buildCreateQuoteBody().items[0],
              description: "Updated line",
              quantity: "1",
              unitPrice: "1000",
              taxIncluded: false
            }
          ],
          validUntil: "2026-08-22T00:00:00.000Z"
        }
      });
      const stale = await context.request({
        method: "PUT",
        path: `/v1/quotes/${created.body!.quoteId}/draft`,
        headers: {
          "Idempotency-Key": "update-draft-stale"
        },
        body: {
          expectedVersion: 1,
          actor: buildCreateQuoteBody().actor,
          source: buildCreateQuoteBody().source,
          customerSnapshot: buildCreateQuoteBody().customerSnapshot,
          items: buildCreateQuoteBody().items,
          validUntil: "2026-08-22T00:00:00.000Z"
        }
      });

      const issuedFixture = await createIssuedFixture(context);
      const issuedUpdate = await context.request({
        method: "PUT",
        path: `/v1/quotes/${issuedFixture.quote.quoteId}/draft`,
        headers: {
          "Idempotency-Key": "update-issued"
        },
        body: {
          expectedVersion: 2,
          actor: buildCreateQuoteBody().actor,
          source: buildCreateQuoteBody().source,
          customerSnapshot: buildCreateQuoteBody().customerSnapshot,
          items: buildCreateQuoteBody().items,
          validUntil: "2026-08-22T00:00:00.000Z"
        }
      });

      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        customerSnapshot: {
          name: "Updated Name"
        },
        version: 2
      });
      expect(stale.body).toMatchObject({
        error: {
          code: "optimistic_concurrency_conflict"
        }
      });
      expect(issuedUpdate.body).toMatchObject({
        error: {
          code: "draft_only_operation"
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("issues a quote with durable document metadata and idempotency completion", async () => {
    await withContext(async (context) => {
      const created = await createDraftViaHttp(context);
      const issueResponse = await context.request<PublicQuoteDto>({
        method: "POST",
        path: `/v1/quotes/${created.body!.quoteId}/issue`,
        headers: {
          "Idempotency-Key": "issue-success"
        },
        body: {
          expectedVersion: 1,
          actor: buildCreateQuoteBody().actor,
          source: buildCreateQuoteBody().source
        }
      });
      const persisted = await context.appContext.quoteService.findById(created.body!.quoteId);
      const audit = await context.appContext.quoteService.listAuditEvents({
        quoteId: created.body!.quoteId,
        limit: 50,
        offset: 0
      });
      const idempotencyRows = await context.appContext.database.query<{ count: string }>(
        `
          select count(*)::text as count
          from quote_service.idempotency_keys
          where operation_name = 'issue_quote'
        `
      );
      const documents = await context.request<PublicIssuedDocumentDto>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/documents`
      });

      expect(issueResponse.status).toBe(200);
      expect(issueResponse.body).toMatchObject({
        status: "issued",
        version: 2,
        issuedDocument: {
          available: true,
          renderVersion: "quote-v1"
        }
      });
      expect(typeof issueResponse.body?.issuedDocument.pdf?.documentRef).toBe("string");
      expect(typeof issueResponse.body?.issuedDocument.html?.documentRef).toBe("string");
      expect(issueResponse.body?.issuedDocument.pdf?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(issueResponse.body?.issuedDocument.html?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted?.status).toBe("issued");
      expect(audit.items.filter((event) => event.action === "issued")).toHaveLength(1);
      expect(idempotencyRows.rows[0]?.count).toBe("1");
      expect(documents.body).toEqual(issueResponse.body?.issuedDocument);
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("supports accept, paid, cancel, expire, and invalid lifecycle transitions", async () => {
    await withContext(async (context) => {
      const issued = await createIssuedFixture(context);
      const accepted = await context.request({
        method: "POST",
        path: `/v1/quotes/${issued.quote.quoteId}/accept`,
        headers: {
          "Idempotency-Key": "accept-1"
        },
        body: {
          expectedVersion: 2,
          actor: issued.quote.actor,
          source: issued.quote.source
        }
      });
      const paid = await context.request({
        method: "POST",
        path: `/v1/quotes/${issued.quote.quoteId}/mark-paid`,
        headers: {
          "Idempotency-Key": "paid-1"
        },
        body: {
          expectedVersion: 3,
          actor: issued.quote.actor,
          source: issued.quote.source
        }
      });

      const cancelSource = await createAcceptedFixture(context);
      const cancelled = await context.request({
        method: "POST",
        path: `/v1/quotes/${cancelSource.quote.quoteId}/cancel`,
        headers: {
          "Idempotency-Key": "cancel-1"
        },
        body: {
          expectedVersion: 3,
          actor: cancelSource.quote.actor,
          source: cancelSource.quote.source
        }
      });

      const expirable = await context.appContext.quoteService.createDraft({
        ...buildCreateQuoteBody(),
        opportunityId: "opp-expire",
        validUntil: "2026-08-10T18:25:01.000Z",
        createdAt: "2026-08-10T18:25:00.000Z",
        idempotencyKey: "expire-draft"
      });
      const expirableIssued = await context.appContext.quoteService.issueQuote({
        quoteId: expirable.quote.quoteId,
        expectedVersion: 1,
        actor: expirable.quote.actor,
        source: expirable.quote.source,
        idempotencyKey: "expire-issue",
        issuedAt: "2026-08-10T18:25:00.500Z",
        issuedDocument: buildIssuedDocument()
      });
      const expired = await context.request({
        method: "POST",
        path: `/v1/quotes/${expirableIssued.quote.quoteId}/expire`,
        headers: {
          "Idempotency-Key": "expire-1"
        },
        body: {
          expectedVersion: 2,
          actor: {
            type: "system",
            id: "system-1"
          },
          source: {
            system: "scheduler",
            correlationId: "sched-1"
          }
        }
      });

      const invalidPaidSource = await createIssuedFixture(context);
      const invalidPaid = await context.request({
        method: "POST",
        path: `/v1/quotes/${invalidPaidSource.quote.quoteId}/mark-paid`,
        headers: {
          "Idempotency-Key": "paid-invalid"
        },
        body: {
          expectedVersion: 2,
          actor: invalidPaidSource.quote.actor,
          source: invalidPaidSource.quote.source
        }
      });

      expect(accepted.status).toBe(200);
      expect(paid.status).toBe(200);
      expect(cancelled.status).toBe(200);
      expect(expired.status).toBe(200);
      expect(invalidPaid.body).toMatchObject({
        error: {
          code: "invalid_quote_status_transition"
        }
      });
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("creates revisions, replays idempotently, and allows only one concurrent winner", async () => {
    await withContext(async (context) => {
      const issued = await createIssuedFixture(context);
      const firstRevision = await context.request<PublicQuoteDto>({
        method: "POST",
        path: `/v1/quotes/${issued.quote.quoteId}/revisions`,
        headers: {
          "Idempotency-Key": "revision-1"
        },
        body: {
          expectedVersion: 2,
          actor: {
            type: "operator",
            id: "operator-1"
          },
          source: {
            system: "manual",
            correlationId: "corr-1"
          },
          newValidUntil: "2026-08-25T00:00:00.000Z"
        }
      });
      const replayed = await context.request<PublicQuoteDto>({
        method: "POST",
        path: `/v1/quotes/${issued.quote.quoteId}/revisions`,
        headers: {
          "Idempotency-Key": "revision-1"
        },
        body: {
          expectedVersion: 2,
          actor: {
            type: "operator",
            id: "operator-1"
          },
          source: {
            system: "manual",
            correlationId: "corr-1"
          },
          newValidUntil: "2026-08-25T00:00:00.000Z"
        }
      });

      expect(firstRevision.status).toBe(201);
      expect(replayed.body).toEqual(firstRevision.body);
      expect(firstRevision.body?.quoteId).not.toBe(issued.quote.quoteId);
      expect(firstRevision.body?.quoteNumber).not.toBe(issued.quote.quoteNumber);
      expect(firstRevision.body?.items[0]?.lineId).not.toBe(issued.quote.items[0]?.lineId);

      const concurrentIssued = await createIssuedFixture(context);
      const concurrentResults = await Promise.all([
        context.request({
          method: "POST",
          path: `/v1/quotes/${concurrentIssued.quote.quoteId}/revisions`,
          headers: {
            "Idempotency-Key": "revision-concurrent-a"
          },
          body: {
            expectedVersion: 2,
            actor: {
              type: "operator",
              id: "operator-a"
            },
            source: {
              system: "manual",
              correlationId: "a"
            }
          }
        }),
        context.request({
          method: "POST",
          path: `/v1/quotes/${concurrentIssued.quote.quoteId}/revisions`,
          headers: {
            "Idempotency-Key": "revision-concurrent-b"
          },
          body: {
            expectedVersion: 2,
            actor: {
              type: "operator",
              id: "operator-b"
            },
            source: {
              system: "manual",
              correlationId: "b"
            }
          }
        })
      ]);

      const successCount = concurrentResults.filter((result) => result.status === 201).length;
      const conflictCount = concurrentResults.filter((result) => result.status === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(1);
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("lists quotes with filters and pagination", async () => {
    await withContext(async (context) => {
      await createDraftViaHttp(context, { opportunityId: "opp-list-a" }, "list-a");
      const second = await createDraftViaHttp(context, { opportunityId: "opp-list-b" }, "list-b");
      const issued = await createIssuedFixture(context);
      const revision = await context.appContext.quoteService.createRevision({
        quoteId: issued.quote.quoteId,
        expectedVersion: 2,
        createdAt: "2026-08-10T19:00:00.000Z",
        actor: {
          type: "operator",
          id: "operator-list"
        },
        source: {
          system: "manual",
          correlationId: "list"
        },
        idempotencyKey: "list-revision"
      });

      const byOpportunity = await context.request<QuoteListResponse>({
        method: "GET",
        path: "/v1/quotes?opportunityId=opp-list-b"
      });
      const byStatus = await context.request<QuoteListResponse>({
        method: "GET",
        path: "/v1/quotes?status=draft&limit=2&offset=0"
      });
      const byRevisionRoot = await context.request<QuoteListResponse>({
        method: "GET",
        path: `/v1/quotes?revisionRootId=${revision.quote.revisionRootId}`
      });

      expect(byOpportunity.status).toBe(200);
      expect(byOpportunity.body).toMatchObject({
        items: [
          {
            quoteId: second.body?.quoteId
          }
        ],
        pagination: {
          limit: 50,
          offset: 0,
          count: 1
        }
      });
      expect(byStatus.body?.items.length).toBe(2);
      expect(byRevisionRoot.body?.items.every((item) => item.revision.rootId === revision.quote.revisionRootId)).toBe(
        true
      );
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("returns audit events without leaking customer PII and in deterministic order", async () => {
    await withContext(async (context) => {
      const created = await createDraftViaHttp(context);
      await context.request({
        method: "PUT",
        path: `/v1/quotes/${created.body!.quoteId}/draft`,
        headers: {
          "Idempotency-Key": "audit-update"
        },
        body: {
          expectedVersion: 1,
          actor: buildCreateQuoteBody().actor,
          source: buildCreateQuoteBody().source,
          customerSnapshot: {
            ...buildCreateQuoteBody().customerSnapshot,
            name: "Audit Updated"
          },
          items: buildCreateQuoteBody().items,
          validUntil: "2026-08-21T00:00:00.000Z"
        }
      });

      const audit = await context.request<QuoteAuditResponse>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/audit?limit=50&offset=0`
      });

      expect(audit.status).toBe(200);
      expect(audit.body?.items.map((event) => event.action)).toEqual([
        "draft_created",
        "draft_updated"
      ]);
      expect(JSON.stringify(audit.body)).not.toContain("jane@example.com");
      expect(JSON.stringify(audit.body)).not.toContain("12345678");
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("sanitizes unexpected infrastructure failures as generic 500 responses", async () => {
    await withContext(async (context) => {
      await context.appContext.database.query(`
        create or replace function quote_service.fail_quote_insert()
        returns trigger
        language plpgsql
        as $$
        begin
          raise exception 'sensitive sql detail should not leak';
        end;
        $$;
      `);
      await context.appContext.database.query(`
        create trigger fail_quote_insert
        before insert on quote_service.quotes
        for each row execute function quote_service.fail_quote_insert();
      `);

      const response = await createDraftViaHttp(context, {}, "create-fails");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "internal_server_error",
          message: "Unexpected server error"
        }
      });
      expect(JSON.stringify(response.body)).not.toContain("sensitive sql detail");
    });
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("uses stable canonical hashes for HTTP idempotency despite server-generated timestamps", () => {
    const body = buildCreateQuoteBody();

    expect(
      createCanonicalRequestHash({
        operation: "create_draft_quote",
        opportunityId: body.opportunityId,
        customerId: body.customerId,
        conversationId: body.conversationId,
        actor: body.actor,
        source: body.source,
        currency: body.currency,
        customerSnapshot: body.customerSnapshot,
        items: body.items,
        validUntil: body.validUntil
      })
    ).toBe(
      createCanonicalRequestHash({
        operation: "create_draft_quote",
        opportunityId: body.opportunityId,
        customerId: body.customerId,
        conversationId: body.conversationId,
        actor: body.actor,
        source: body.source,
        currency: body.currency,
        customerSnapshot: body.customerSnapshot,
        items: body.items,
        validUntil: body.validUntil
      })
    );
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);
});
