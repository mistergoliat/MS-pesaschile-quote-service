import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ApplicationError } from "../../src/application/quote/errors";
import {
  createHttpQuoteTestContext,
  type HttpQuoteTestContext
} from "../helpers/http-quote-test-context";

interface QuoteResponse {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly status: string;
  readonly version: number;
  readonly issuedDocument: {
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
  };
}

interface QuoteAuditResponse {
  readonly items: Array<{ action: string; payload: Record<string, unknown> }>;
}

const DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS = 60_000;

function buildCreateQuoteBody() {
  return {
    opportunityId: "opp-docs-1",
    customerId: "customer-docs-1",
    conversationId: "conversation-docs-1",
    actor: {
      type: "sales_agent" as const,
      id: "agent-docs-1"
    },
    source: {
      system: "crm_customer_360" as const,
      correlationId: "corr-docs-1"
    },
    currency: "CLP" as const,
    customerSnapshot: {
      name: "Jane <Doe>",
      businessName: "Pesas Chile",
      email: "jane@example.com",
      phone: "12345678",
      address: "Street 1",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        type: "product" as const,
        externalItemId: "sku-1",
        sku: "SKU-1",
        description: `Servicio "Premium" & <b>instalacion</b>`,
        quantity: "2",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19"
      }
    ],
    validUntil: "2026-08-20T00:00:00.000Z"
  };
}

async function createDraft(context: HttpQuoteTestContext, idempotencyKey: string) {
  return context.request<QuoteResponse>({
    method: "POST",
    path: "/v1/quotes",
    headers: {
      "Idempotency-Key": idempotencyKey
    },
    body: buildCreateQuoteBody()
  });
}

async function issueDraft(
  context: HttpQuoteTestContext,
  quoteId: string,
  idempotencyKey: string
) {
  return context.request<QuoteResponse>({
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

async function listStoredFiles(rootPath: string): Promise<string[]> {
  async function walk(currentPath: string): Promise<string[]> {
    const entries = await fsPromises.readdir(currentPath, {
      withFileTypes: true
    });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await walk(entryPath)));
        continue;
      }

      files.push(path.relative(rootPath, entryPath).replaceAll("\\", "/"));
    }

    return files;
  }

  return walk(rootPath);
}

describe("Quote document issuance", () => {
  it("issues a quote, streams PDF and HTML, and survives app restart", async () => {
    const firstContext = await createHttpQuoteTestContext({
      preserveDatabaseOnDispose: true,
      preserveStorageOnDispose: true
    });
    const sharedDatabaseHandle = firstContext.databaseHandle;
    const sharedStorageRoot = firstContext.storageRoot;

    try {
      const created = await createDraft(firstContext, "create-documents-restart");
      const issued = await issueDraft(firstContext, created.body!.quoteId, "issue-documents-restart");

      expect(issued.status).toBe(200);
      expect(issued.body?.status).toBe("issued");
      expect(issued.body?.issuedDocument).toMatchObject({
        available: true,
        renderVersion: "quote-v1"
      });

      const pdfRef = issued.body?.issuedDocument.pdf.documentRef;
      const htmlRef = issued.body?.issuedDocument.html.documentRef;

      expect(pdfRef).toMatch(/^doc_/);
      expect(htmlRef).toMatch(/^doc_/);

      const pdf = await firstContext.requestRaw({
        method: "GET",
        path: `/v1/documents/${pdfRef!}`
      });
      const html = await firstContext.requestRaw({
        method: "GET",
        path: `/v1/documents/${htmlRef!}`
      });

      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toContain("application/pdf");
      expect(pdf.headers.get("content-disposition")).toContain(".pdf");
      expect(pdf.bodyBuffer.byteLength).toBeGreaterThan(100);
      expect(pdf.bodyBuffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
      expect(crypto.createHash("sha256").update(pdf.bodyBuffer).digest("hex")).toBe(
        issued.body?.issuedDocument.pdf.sha256
      );

      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.bodyText).toContain(issued.body!.quoteNumber);
      expect(html.bodyText).toContain("&lt;b&gt;instalacion&lt;/b&gt;");
      expect(crypto.createHash("sha256").update(html.bodyBuffer).digest("hex")).toBe(
        issued.body?.issuedDocument.html.sha256
      );

      await firstContext.dispose();

      const secondContext = await createHttpQuoteTestContext({
        databaseHandle: sharedDatabaseHandle,
        storageRoot: sharedStorageRoot
      });

      try {
        const reloadedQuote = await secondContext.request<QuoteResponse>({
          method: "GET",
          path: `/v1/quotes/${issued.body!.quoteId}`
        });
        const reloadedPdf = await secondContext.requestRaw({
          method: "GET",
          path: `/v1/documents/${pdfRef!}`
        });
        const reloadedHtml = await secondContext.requestRaw({
          method: "GET",
          path: `/v1/documents/${htmlRef!}`
        });

        expect(reloadedQuote.body?.issuedDocument).toEqual(issued.body?.issuedDocument);
        expect(crypto.createHash("sha256").update(reloadedPdf.bodyBuffer).digest("hex")).toBe(
          issued.body?.issuedDocument.pdf.sha256
        );
        expect(crypto.createHash("sha256").update(reloadedHtml.bodyBuffer).digest("hex")).toBe(
          issued.body?.issuedDocument.html.sha256
        );
      } finally {
        await secondContext.dispose();
      }
    } catch (error) {
      await firstContext.dispose().catch(() => undefined);
      throw error;
    }
  }, DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS);

  it("replays /issue with the same idempotency key without duplicating audit", async () => {
    const context = await createHttpQuoteTestContext();

    try {
      const created = await createDraft(context, "create-documents-replay");
      const firstIssue = await issueDraft(context, created.body!.quoteId, "issue-replay");
      const replay = await issueDraft(context, created.body!.quoteId, "issue-replay");
      const audit = await context.request<QuoteAuditResponse>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/audit?limit=50&offset=0`
      });

      expect(firstIssue.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(firstIssue.body);
      expect(audit.body?.items.filter((event) => event.action === "issued")).toHaveLength(1);
    } finally {
      await context.dispose();
    }
  }, DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves the quote in draft when the PDF renderer cannot start", async () => {
    const context = await createHttpQuoteTestContext({
      applicationOverrides: {
        documentIssuancePort: {
          issueForQuote() {
            return Promise.reject(
              new ApplicationError(
                "document_generation_failed",
                "Document generation failed"
              )
            );
          },
          async cleanupIssuedArtifacts() {}
        }
      }
    });

    try {
      const created = await createDraft(context, "create-renderer-failure");
      const issue = await issueDraft(context, created.body!.quoteId, "issue-renderer-failure");
      const persisted = await context.request<QuoteResponse>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}`
      });
      const audit = await context.request<QuoteAuditResponse>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/audit?limit=50&offset=0`
      });
      const idempotencyRows = await context.appContext.database.query<{ status: string }>(
        `
          select status
          from quote_service.idempotency_keys
          where idempotency_key = 'issue-renderer-failure'
            and operation_name = 'issue_quote'
        `
      );

      expect(issue).toMatchObject({
        status: 503,
        body: {
          error: {
            code: "document_generation_failed"
          }
        }
      });
      expect(persisted.body?.status).toBe("draft");
      expect(audit.body?.items.some((event) => event.action === "issued")).toBe(false);
      expect(idempotencyRows.rows[0]?.status).toBe("failed");
    } finally {
      await context.dispose();
    }
  }, DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS);

  it("allows only one concurrent issue winner and cleans losing artifacts", async () => {
    const context = await createHttpQuoteTestContext();

    try {
      const created = await createDraft(context, "create-concurrent-issue");
      const [first, second] = await Promise.all([
        issueDraft(context, created.body!.quoteId, "issue-concurrent-a"),
        issueDraft(context, created.body!.quoteId, "issue-concurrent-b")
      ]);
      const outcomes = [first, second];
      const winner = outcomes.find((response) => response.status === 200);
      const loser = outcomes.find((response) => response.status !== 200);
      const audit = await context.request<QuoteAuditResponse>({
        method: "GET",
        path: `/v1/quotes/${created.body!.quoteId}/audit?limit=50&offset=0`
      });
      const storedFiles = await listStoredFiles(context.storageRoot);

      expect(winner?.body?.status).toBe("issued");
      expect(loser?.status).toBe(409);
      expect([
        "optimistic_concurrency_conflict",
        "draft_only_operation",
        "invalid_quote_status_transition"
      ]).toContain(
        (loser?.body as { error?: { code?: string } } | undefined)?.error?.code
      );
      expect(audit.body?.items.filter((event) => event.action === "issued")).toHaveLength(1);
      expect(storedFiles.filter((storageKey) => storageKey.startsWith("quotes/"))).toHaveLength(3);
    } finally {
      await context.dispose();
    }
  }, DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects malformed or tampered document references without leaking internals", async () => {
    const context = await createHttpQuoteTestContext();

    try {
      const created = await createDraft(context, "create-documents-tamper");
      const issued = await issueDraft(context, created.body!.quoteId, "issue-documents-tamper");
      const validPdfRef = issued.body!.issuedDocument.pdf.documentRef!;
      const tamperedPdfRef = `${validPdfRef.slice(0, -1)}${validPdfRef.endsWith("a") ? "b" : "a"}`;
      const malformed = await context.request({
        method: "GET",
        path: "/v1/documents/doc_not-a-signed-ref"
      });
      const tampered = await context.request({
        method: "GET",
        path: `/v1/documents/${tamperedPdfRef}`
      });

      expect(malformed).toMatchObject({
        status: 404,
        body: {
          error: {
            code: "document_not_found"
          }
        }
      });
      expect(tampered).toMatchObject({
        status: 404,
        body: {
          error: {
            code: "document_not_found"
          }
        }
      });
      expect(JSON.stringify(tampered.body)).not.toContain(context.storageRoot);
    } finally {
      await context.dispose();
    }
  }, DOCUMENT_INTEGRATION_TEST_TIMEOUT_MS);
});
