import { describe, expect, it } from "vitest";

import {
  EmailSendError,
  classifyQuoteEmailFailure,
  resolveNextRetryAt
} from "../../src/application/quote-delivery/retry-policy";

describe("quote email retry policy", () => {
  it("schedules the next retry for retryable provider failures", () => {
    const decision = classifyQuoteEmailFailure({
      error: new EmailSendError("gmail_api_rate_limited", "temporary Gmail issue", true),
      now: "2026-08-12T12:00:00.000Z",
      attemptCount: 1,
      maxAttempts: 5
    });

    expect(decision).toEqual({
      retryable: true,
      nextAttemptAt: "2026-08-12T12:01:00.000Z",
      failureCode: "gmail_api_rate_limited",
      failureMessage: "temporary Gmail issue"
    });
  });

  it("stops retrying when max attempts is reached", () => {
    expect(
      resolveNextRetryAt("2026-08-12T12:00:00.000Z", 5, 5)
    ).toBeNull();
  });

  it("treats unknown errors as terminal failures", () => {
    const decision = classifyQuoteEmailFailure({
      error: new Error("boom"),
      now: "2026-08-12T12:00:00.000Z",
      attemptCount: 1,
      maxAttempts: 5
    });

    expect(decision.retryable).toBe(false);
    expect(decision.nextAttemptAt).toBeNull();
    expect(decision.failureCode).toBe("unexpected_email_delivery_error");
  });
});
