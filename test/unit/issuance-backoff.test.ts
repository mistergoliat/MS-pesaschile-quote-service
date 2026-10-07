import { describe, expect, it } from "vitest";

import { issuanceBackoffMs } from "../../src/application/quote-v2/issuance-operation";

describe("issuance backoff (Idempotency §4.2)", () => {
  it.each([
    ["Q", 1, 5_000],
    ["R", 2, 30_000],
    ["S", 3, 120_000],
    ["T", 4, 600_000],
    ["U", 5, 1_800_000],
    ["V", 6, 3_600_000],
    ["V", 7, 3_600_000],
    ["V", 1_000, 3_600_000]
  ])("%s: failed attempt %i retries after %i ms", (_id, attempt, expected) => {
    expect(issuanceBackoffMs(attempt)).toBe(expected);
  });

  it("rejects attempt numbers that cannot follow a claim", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => issuanceBackoffMs(attempt)).toThrow(RangeError);
    }
  });
});
