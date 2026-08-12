import crypto from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { EmailSendError } from "../../src/application/quote-delivery/retry-policy";
import {
  createHttpQuoteTestContext,
  MutableClock,
  type HttpQuoteTestContext
} from "../helpers/http-quote-test-context";

interface PublicQuoteDeliveryDto {
  readonly deliveryId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
  readonly timestamps: {
    readonly sentAt: string | null;
    readonly failedAt: string | null;
    readonly nextAttemptAt: string | null;
  };
}

interface QuoteAuditResponse {
  readonly items: Array<{ action: string; payload: Record<string, unknown> }>;
}

const RUNTIME_INTEGRATION_TEST_TIMEOUT_MS = 60_000;

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

async function createIssuedQuote(context: HttpQuoteTestContext) {
  const created = await context.request<{ readonly quoteId: string }>({
    method: "POST",
    path: "/v1/quotes",
    headers: {
      "Idempotency-Key": `create-email-runtime-${crypto.randomUUID()}`
    },
    body: {
      opportunityId: "opp-email-runtime",
      customerId: "customer-email-runtime",
      conversationId: "conversation-email-runtime",
      actor: {
        type: "sales_agent",
        id: "agent-email-runtime"
      },
      source: {
        system: "crm_customer_360",
        correlationId: "corr-email-runtime"
      },
      currency: "CLP",
      customerSnapshot: {
        name: "Runtime Email User",
        email: "runtime@example.com"
      },
      items: [
        {
          type: "product",
          description: "Industrial scale",
          quantity: "1",
          unitPrice: "150000",
          taxIncluded: false,
          taxRate: "0.19"
        }
      ],
      validUntil: "2026-08-20T00:00:00.000Z"
    }
  });
  const issued = await context.request<{ readonly quoteId: string }>({
    method: "POST",
    path: `/v1/quotes/${created.body!.quoteId}/issue`,
    headers: {
      "Idempotency-Key": `issue-email-runtime-${crypto.randomUUID()}`
    },
    body: {
      expectedVersion: 1,
      actor: {
        type: "sales_agent",
        id: "agent-email-runtime"
      },
      source: {
        system: "crm_customer_360",
        correlationId: "corr-email-runtime-issue"
      }
    }
  });

  return issued.body!.quoteId;
}

async function requestDelivery(context: HttpQuoteTestContext, quoteId: string) {
  const response = await context.request<PublicQuoteDeliveryDto>({
    method: "POST",
    path: `/v1/quotes/${quoteId}/send-email`,
    headers: {
      "Idempotency-Key": `send-email-runtime-${crypto.randomUUID()}`
    },
    body: {
      actor: {
        type: "sales_agent",
        id: "agent-email-runtime"
      },
      source: {
        system: "crm_customer_360",
        correlationId: "corr-email-runtime-send"
      }
    }
  });

  expect(response.status).toBe(202);
  return response.body!;
}

async function getDelivery(context: HttpQuoteTestContext, quoteId: string, deliveryId: string) {
  return context.request<PublicQuoteDeliveryDto>({
    method: "GET",
    path: `/v1/quotes/${quoteId}/deliveries/${deliveryId}`
  });
}

async function getAudit(context: HttpQuoteTestContext, quoteId: string) {
  return context.request<QuoteAuditResponse>({
    method: "GET",
    path: `/v1/quotes/${quoteId}/audit?limit=50&offset=0`
  });
}

function buildGmailEnvOverrides() {
  return {
    QUOTE_EMAIL_PROVIDER: "gmail" as const,
    GOOGLE_GMAIL_CLIENT_ID: "gmail-client-id",
    GOOGLE_GMAIL_CLIENT_SECRET: "gmail-client-secret",
    GOOGLE_GMAIL_REFRESH_TOKEN: "gmail-refresh-token",
    GOOGLE_GMAIL_USER: "quotes@pesaschile.cl",
    QUOTE_EMAIL_FROM_ADDRESS: "quotes@pesaschile.cl",
    QUOTE_EMAIL_FROM_NAME: "Pesas Chile",
    QUOTE_EMAIL_DELIVERY_INTERVAL_MS: 3_600_000,
    QUOTE_EMAIL_DELIVERY_BATCH_SIZE: 25,
    QUOTE_EMAIL_DELIVERY_LEASE_MS: 60_000,
    QUOTE_EMAIL_DELIVERY_MAX_ATTEMPTS: 5
  };
}

describe("quote email runtime", () => {
  let context: HttpQuoteTestContext | null = null;

  afterEach(async () => {
    await context?.dispose();
    context = null;
  });

  it("processes queued quote emails and records sent audit", async () => {
    const sentMessages: string[] = [];
    context = await createHttpQuoteTestContext({
      envOverrides: buildGmailEnvOverrides(),
      applicationOverrides: {
        emailSenderPort: {
          send(input) {
            sentMessages.push(input.subject);
            return Promise.resolve({
              providerMessageId: "provider-msg-1"
            });
          }
        }
      }
    });
    const quoteId = await createIssuedQuote(context);
    const delivery = await requestDelivery(context, quoteId);

    await context.appContext.backgroundJobs.runEmailDeliveryNow();

    const persisted = await getDelivery(context, quoteId, delivery.deliveryId);
    const audit = await getAudit(context, quoteId);

    expect(sentMessages).toEqual([expect.stringContaining("PC-")]);
    expect(persisted.body).toMatchObject({
      status: "sent",
      attemptCount: 1,
      providerMessageId: "provider-msg-1"
    });
    expect(audit.body?.items.some((event) => event.action === "email_delivery_sent")).toBe(true);
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("retries transient failures and eventually sends the email", async () => {
    const clock = new MutableClock("2026-08-12T14:00:00.000Z");
    let attempts = 0;
    context = await createHttpQuoteTestContext({
      clock,
      envOverrides: buildGmailEnvOverrides(),
      applicationOverrides: {
        emailSenderPort: {
          send() {
            attempts += 1;

            if (attempts === 1) {
              return Promise.reject(
                new EmailSendError("gmail_api_rate_limited", "temporary outage", true)
              );
            }

            return Promise.resolve({
              providerMessageId: "provider-msg-2"
            });
          }
        }
      }
    });
    const quoteId = await createIssuedQuote(context);
    const delivery = await requestDelivery(context, quoteId);

    await context.appContext.backgroundJobs.runEmailDeliveryNow();

    const failed = await getDelivery(context, quoteId, delivery.deliveryId);
    expect(failed.body).toMatchObject({
      status: "failed",
      attemptCount: 1,
      failureCode: "gmail_api_rate_limited"
    });
    expect(failed.body?.timestamps.nextAttemptAt).toBe("2026-08-12T14:01:00.000Z");

    clock.set("2026-08-12T14:01:01.000Z");
    await context.appContext.backgroundJobs.runEmailDeliveryNow();

    const sent = await getDelivery(context, quoteId, delivery.deliveryId);
    const audit = await getAudit(context, quoteId);

    expect(sent.body).toMatchObject({
      status: "sent",
      attemptCount: 2,
      providerMessageId: "provider-msg-2"
    });
    expect(audit.body?.items.some((event) => event.action === "email_delivery_failed")).toBe(true);
    expect(
      audit.body?.items.some((event) => event.action === "email_delivery_retry_scheduled")
    ).toBe(true);
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);

  it("recovers pending deliveries after restart when the worker is enabled", async () => {
    const firstContext = await createHttpQuoteTestContext({
      preserveDatabaseOnDispose: true,
      preserveStorageOnDispose: true,
      envOverrides: {
        ...buildGmailEnvOverrides(),
        QUOTE_EMAIL_DELIVERY_INTERVAL_MS: 3_600_000
      },
      applicationOverrides: {
        emailSenderPort: {
          send() {
            return Promise.resolve({
              providerMessageId: "provider-msg-restart"
            });
          }
        }
      }
    });
    const sharedDatabaseHandle = firstContext.databaseHandle;
    const sharedStorageRoot = firstContext.storageRoot;

    try {
      const quoteId = await createIssuedQuote(firstContext);
      const delivery = await requestDelivery(firstContext, quoteId);
      await firstContext.dispose();

      context = await createHttpQuoteTestContext({
        databaseHandle: sharedDatabaseHandle,
        storageRoot: sharedStorageRoot,
        envOverrides: {
          ...buildGmailEnvOverrides(),
          QUOTE_EMAIL_DELIVERY_INTERVAL_MS: 1_000
        },
        applicationOverrides: {
          emailSenderPort: {
            send() {
              return Promise.resolve({
                providerMessageId: "provider-msg-restart"
              });
            }
          }
        }
      });

      const persisted = await pollUntil(
        () => getDelivery(context!, quoteId, delivery.deliveryId),
        (response) => response.body?.status === "sent"
      );

      expect(persisted.body?.providerMessageId).toBe("provider-msg-restart");
    } catch (error) {
      await firstContext.dispose().catch(() => undefined);
      throw error;
    }
  }, RUNTIME_INTEGRATION_TEST_TIMEOUT_MS);
});
