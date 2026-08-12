import crypto from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { PublicQuoteDto } from "../../src/http/quote-presenter";
import {
  createHttpQuoteTestContext,
  type HttpQuoteTestContext
} from "../helpers/http-quote-test-context";

interface PublicQuoteDeliveryDto {
  readonly deliveryId: string;
  readonly quoteId: string;
  readonly channel: "email";
  readonly recipient: string;
  readonly status: string;
  readonly attemptCount: number;
}

const HTTP_INTEGRATION_TEST_TIMEOUT_MS = 60_000;

async function createIssuedQuote(context: HttpQuoteTestContext): Promise<PublicQuoteDto> {
  const created = await context.request<PublicQuoteDto>({
    method: "POST",
    path: "/v1/quotes",
    headers: {
      "Idempotency-Key": `create-email-http-${crypto.randomUUID()}`
    },
    body: {
      opportunityId: "opp-email-http",
      customerId: "customer-email-http",
      conversationId: "conversation-email-http",
      actor: {
        type: "sales_agent",
        id: "agent-email-http"
      },
      source: {
        system: "crm_customer_360",
        correlationId: "corr-email-http"
      },
      currency: "CLP",
      customerSnapshot: {
        name: "HTTP User",
        email: "buyer@example.com"
      },
      items: [
        {
          type: "product",
          description: "Bench scale",
          quantity: "1",
          unitPrice: "55000",
          taxIncluded: false,
          taxRate: "0.19"
        }
      ],
      validUntil: "2026-08-20T00:00:00.000Z"
    }
  });
  const issued = await context.request<PublicQuoteDto>({
    method: "POST",
    path: `/v1/quotes/${created.body!.quoteId}/issue`,
    headers: {
      "Idempotency-Key": `issue-email-http-${crypto.randomUUID()}`
    },
    body: {
      expectedVersion: 1,
      actor: {
        type: "sales_agent",
        id: "agent-email-http"
      },
      source: {
        system: "crm_customer_360",
        correlationId: "corr-email-http-issue"
      }
    }
  });

  expect(issued.status).toBe(200);
  return issued.body!;
}

describe("quote email HTTP", () => {
  let context: HttpQuoteTestContext | null = null;

  afterEach(async () => {
    await context?.dispose();
    context = null;
  });

  it("accepts send-email requests and exposes delivery history endpoints", async () => {
    context = await createHttpQuoteTestContext({
      envOverrides: {
        QUOTE_EMAIL_PROVIDER: "gmail",
        GOOGLE_GMAIL_CLIENT_ID: "gmail-client-id",
        GOOGLE_GMAIL_CLIENT_SECRET: "gmail-client-secret",
        GOOGLE_GMAIL_REFRESH_TOKEN: "gmail-refresh-token",
        GOOGLE_GMAIL_USER: "quotes@pesaschile.cl",
        QUOTE_EMAIL_FROM_ADDRESS: "quotes@pesaschile.cl",
        QUOTE_EMAIL_FROM_NAME: "Pesas Chile"
      },
      applicationOverrides: {
        emailSenderPort: {
          send() {
            return Promise.resolve({
              providerMessageId: "provider-message-id"
            });
          }
        }
      }
    });
    const issued = await createIssuedQuote(context);
    const idempotencyKey = `send-email-http-${crypto.randomUUID()}`;

    const first = await context.request<PublicQuoteDeliveryDto>({
      method: "POST",
      path: `/v1/quotes/${issued.quoteId}/send-email`,
      headers: {
        "Idempotency-Key": idempotencyKey
      },
      body: {
        actor: {
          type: "sales_agent",
          id: "agent-email-http"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-email-http-send"
        }
      }
    });
    const replay = await context.request<PublicQuoteDeliveryDto>({
      method: "POST",
      path: `/v1/quotes/${issued.quoteId}/send-email`,
      headers: {
        "Idempotency-Key": idempotencyKey
      },
      body: {
        actor: {
          type: "sales_agent",
          id: "agent-email-http"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-email-http-send"
        }
      }
    });
    const list = await context.request<{
      readonly items: readonly PublicQuoteDeliveryDto[];
      readonly pagination: { readonly count: number };
    }>({
      method: "GET",
      path: `/v1/quotes/${issued.quoteId}/deliveries?limit=50&offset=0`
    });
    const byId = await context.request<PublicQuoteDeliveryDto>({
      method: "GET",
      path: `/v1/quotes/${issued.quoteId}/deliveries/${first.body!.deliveryId}`
    });

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      quoteId: issued.quoteId,
      channel: "email",
      recipient: "buyer@example.com",
      status: "pending",
      attemptCount: 0
    });
    expect(list.body?.items).toHaveLength(1);
    expect(list.body?.items[0]?.deliveryId).toBe(first.body?.deliveryId);
    expect(byId.body?.deliveryId).toBe(first.body?.deliveryId);
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);

  it("returns 503 when email delivery is not configured", async () => {
    context = await createHttpQuoteTestContext();
    const issued = await createIssuedQuote(context);

    const response = await context.request<{
      readonly error: {
        readonly code: string;
      };
    }>({
      method: "POST",
      path: `/v1/quotes/${issued.quoteId}/send-email`,
      headers: {
        "Idempotency-Key": `send-email-disabled-${crypto.randomUUID()}`
      },
      body: {
        actor: {
          type: "sales_agent",
          id: "agent-email-http"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-email-http-disabled"
        }
      }
    });

    expect(response.status).toBe(503);
    expect(response.body?.error.code).toBe("email_delivery_unavailable");
  }, HTTP_INTEGRATION_TEST_TIMEOUT_MS);
});
