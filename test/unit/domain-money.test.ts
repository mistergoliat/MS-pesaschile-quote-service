import { describe, expect, it } from "vitest";

import {
  DOMAIN_ERROR_CODES,
  MoneyAmount,
  QuoteLine,
  QuotePricing,
  type QuoteLineInput
} from "../../src/domain";
import { expectDomainError } from "./domain-test-helpers";

describe("money model", () => {
  it("rounds CLP amounts to zero minor units using half-up", () => {
    expect(MoneyAmount.from("CLP", "10.4").toString()).toBe("10");
    expect(MoneyAmount.from("CLP", "10.5").toString()).toBe("11");
  });

  it("multiplies and divides using the centralized rounding policy", () => {
    const amount = MoneyAmount.from("CLP", "1001");

    expect(amount.multiply("1.5").toString()).toBe("1502");
    expect(amount.divide("3").toString()).toBe("334");
  });

  it("calculates tax excluded lines deterministically", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        description: "Tax excluded",
        quantity: "2",
        unitPrice: "1000",
        taxIncluded: false,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toMatchObject({
      lineSubtotal: "2000",
      lineTax: "380",
      lineTotal: "2380"
    });
  });

  it("calculates tax included lines and preserves subtotal plus tax equals total", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "service",
        description: "Tax included",
        quantity: "3",
        unitPrice: "1190",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toMatchObject({
      lineSubtotal: "3000",
      lineTax: "570",
      lineTotal: "3570"
    });
  });

  it("handles large values without using JS floating point", () => {
    const lineA = QuoteLine.create(
      {
        lineId: "line-a",
        type: "product",
        description: "Large A",
        quantity: "1250",
        unitPrice: "999999",
        taxIncluded: false,
        taxRate: "0.19"
      },
      "CLP"
    );
    const lineB = QuoteLine.create(
      {
        lineId: "line-b",
        type: "service",
        description: "Large B",
        quantity: "875",
        unitPrice: "1500000",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    const pricing = QuotePricing.fromLines("CLP", [lineA, lineB]);

    expect(pricing.toSnapshot()).toEqual({
      subtotal: "2352939926",
      taxAmount: "447058587",
      total: "2799998513"
    });
  });

  it("rejects invalid decimal inputs", () => {
    expectDomainError(
      () => MoneyAmount.from("CLP", "NaN"),
      DOMAIN_ERROR_CODES.invalidMoneyAmount
    );
  });

  it("reconciles quote pricing using the sum of rounded line totals", () => {
    const inputs: QuoteLineInput[] = [
      {
        lineId: "line-1",
        type: "product",
        description: "A",
        quantity: "1",
        unitPrice: "1000",
        taxIncluded: true,
        taxRate: "0.19"
      },
      {
        lineId: "line-2",
        type: "service",
        description: "B",
        quantity: "1",
        unitPrice: "1000",
        taxIncluded: true,
        taxRate: "0.19"
      }
    ];

    const pricing = QuotePricing.fromLines(
      "CLP",
      inputs.map((input) => QuoteLine.create(input, "CLP"))
    );

    expect(pricing.toSnapshot()).toEqual({
      subtotal: "1680",
      taxAmount: "320",
      total: "2000"
    });
  });
});
