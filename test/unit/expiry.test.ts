import { describe, expect, it } from "vitest";

import { effectiveExpiry, effectiveStatusSql, isPastValidity } from "../../src/application/quote-v2/expiry";

const boundary = new Date("2026-10-09T03:00:00Z");
const at = (offsetMs: number) => new Date(boundary.getTime() + offsetMs);

describe("effective expiry projection (state machine T9, validity V-6)", () => {
  it("issued projects expired exactly at validUntilExclusive, with expiredAt = the boundary", () => {
    const issued = { status: "issued", validUntilExclusive: boundary, expiredAt: null };

    expect(effectiveExpiry(issued, at(-1))).toEqual({ status: "issued", expiredAt: null });
    expect(effectiveExpiry(issued, at(0))).toEqual({ status: "expired", expiredAt: boundary });
    expect(effectiveExpiry(issued, at(86_400_000))).toEqual({ status: "expired", expiredAt: boundary });
  });

  it("only stored issued projects; materialized expiry keeps its recorded instant", () => {
    for (const status of ["draft", "issuing", "cancelled"]) {
      expect(effectiveExpiry({ status, validUntilExclusive: boundary, expiredAt: null }, at(1)).status).toBe(status);
    }

    const legacyExpiredAt = at(5_000);
    expect(effectiveExpiry({ status: "expired", validUntilExclusive: boundary, expiredAt: legacyExpiredAt }, at(10_000))).toEqual({
      status: "expired",
      expiredAt: legacyExpiredAt
    });
  });

  it("validity predicate is now ≥ validUntilExclusive; no validity never expires", () => {
    expect(isPastValidity(boundary, at(-1))).toBe(false);
    expect(isPastValidity(boundary, at(0))).toBe(true);
    expect(isPastValidity(null, at(0))).toBe(false);
  });

  it("the SQL form uses the same inclusive boundary", () => {
    expect(effectiveStatusSql("q", "$4")).toMatch(/q\.status = 'issued' and q\.valid_until_exclusive <= \$4::timestamptz/);
  });
});
