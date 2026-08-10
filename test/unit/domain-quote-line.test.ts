import { describe, expect, it } from "vitest";

import { DOMAIN_ERROR_CODES, QuoteLine } from "../../src/domain";
import { expectDomainError } from "./domain-test-helpers";

describe("QuoteLine", () => {
  it("creates a valid product line", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        externalItemId: " ext-1 ",
        sku: " sku-1 ",
        description: " Product line ",
        quantity: "2",
        unitPrice: "5000",
        taxIncluded: false,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toEqual({
      lineId: "line-1",
      type: "product",
      externalItemId: "ext-1",
      sku: "sku-1",
      description: "Product line",
      quantity: "2",
      unitPrice: "5000",
      taxIncluded: false,
      taxRate: "0.19",
      lineSubtotal: "10000",
      lineTax: "1900",
      lineTotal: "11900"
    });
  });

  it("creates a valid service line", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-2",
        type: "service",
        description: "Service line",
        quantity: "1",
        unitPrice: "1190",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot().type).toBe("service");
  });

  it("rejects zero quantity", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          description: "Invalid",
          quantity: "0",
          unitPrice: "1000",
          taxIncluded: false,
          taxRate: "0.19"
        },
        "CLP"
        ),
      DOMAIN_ERROR_CODES.invalidLineQuantity
    );
  });

  it("rejects negative quantity", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          description: "Invalid",
          quantity: "-1",
          unitPrice: "1000",
          taxIncluded: false,
          taxRate: "0.19"
        },
        "CLP"
        ),
      DOMAIN_ERROR_CODES.invalidLineQuantity
    );
  });

  it("rejects negative price", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          description: "Invalid",
          quantity: "1",
          unitPrice: "-1",
          taxIncluded: false,
          taxRate: "0.19"
        },
        "CLP"
        ),
      DOMAIN_ERROR_CODES.invalidLinePrice
    );
  });

  it("rejects negative tax rate", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          description: "Invalid",
          quantity: "1",
          unitPrice: "1000",
          taxIncluded: false,
          taxRate: "-0.01"
        },
        "CLP"
        ),
      DOMAIN_ERROR_CODES.invalidTaxRate
    );
  });

  it("rejects overlong reference strings", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          externalItemId: "x".repeat(201),
          description: "Invalid",
          quantity: "1",
          unitPrice: "1000",
          taxIncluded: false,
          taxRate: "0.19"
        },
        "CLP"
        ),
      DOMAIN_ERROR_CODES.invalidQuoteReference
    );
  });
});
