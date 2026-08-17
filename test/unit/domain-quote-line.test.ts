import { describe, expect, it } from "vitest";

import { DOMAIN_ERROR_CODES, QuoteLine } from "../../src/domain";
import { expectDomainError } from "./domain-test-helpers";

describe("QuoteLine", () => {
  it("creates a valid product line", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        externalSource: " catalog_service ",
        externalItemId: " ext-1 ",
        externalVariantId: null,
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
      externalSource: "catalog_service",
      externalItemId: "ext-1",
      externalVariantId: null,
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

  // SALES-AGENT-R1-T1.1, task section 13.1: a base product (no variant) -
  // externalVariantId stays null, never fabricated as "0" or "".
  it("creates a valid product base line (catalog product, no variant)", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        externalSource: "catalog_service",
        externalItemId: "545",
        externalVariantId: null,
        sku: "BAR-OLY-20",
        description: "Barra olimpica 20 kg",
        quantity: "1",
        unitPrice: "99990",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toMatchObject({
      externalSource: "catalog_service",
      externalItemId: "545",
      externalVariantId: null
    });
  });

  // SALES-AGENT-R1-T1.1, task section 13.2: a specific catalog variant -
  // externalItemId (the product) and externalVariantId (the combination)
  // are both real, independent identity fields - never concatenated.
  it("creates a valid product line for a specific catalog variant", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        externalSource: "catalog_service",
        externalItemId: "545",
        externalVariantId: "31",
        sku: "BAR-OLY-20-BLK",
        description: "Barra olimpica 20 kg - negra",
        quantity: "1",
        unitPrice: "99990",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toMatchObject({
      externalSource: "catalog_service",
      externalItemId: "545",
      externalVariantId: "31"
    });
  });

  // SALES-AGENT-R1-T1.1, task section 3/12: catalog identity is never a
  // universal requirement - a legacy/manual line (e.g. a service with no
  // catalog counterpart) is still valid with all three fields absent.
  it("creates a valid line with no catalog identity at all (legacy/manual line)", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "service",
        description: "Servicio de instalacion",
        quantity: "1",
        unitPrice: "15000",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    expect(line.toSnapshot()).toMatchObject({
      externalSource: null,
      externalItemId: null,
      externalVariantId: null
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

  it("rejects an overlong externalSource", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          externalSource: "x".repeat(101),
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

  // SALES-AGENT-R1-T1.1, task section 14 (mandatory regression test).
  // Catalog Service already reports a tax-included commercial price
  // (taxIncluded=true) - unitPrice IS the final customer price. This line
  // must never multiply it by (1+taxRate) again: lineTotal for quantity=1
  // is exactly unitPrice, never unitPrice*1.19.
  it("tax-included catalog price is not taxed twice", () => {
    const line = QuoteLine.create(
      {
        lineId: "line-1",
        type: "product",
        externalSource: "catalog_service",
        externalItemId: "545",
        externalVariantId: null,
        sku: "BAR-OLY-20",
        description: "Barra olimpica 20 kg",
        quantity: "1",
        unitPrice: "99990",
        taxIncluded: true,
        taxRate: "0.19"
      },
      "CLP"
    );

    const snapshot = line.toSnapshot();

    expect(snapshot.lineTotal).toBe("99990");
    expect(snapshot.lineTotal).not.toBe("118988");
    expect(snapshot.lineTotal).not.toBe("118989");
    expect(snapshot.lineTotal).not.toBe("118990");
    // lineSubtotal + lineTax must reconcile back to the exact same total -
    // the split changes, the customer-facing total never does.
    expect(Number(snapshot.lineSubtotal) + Number(snapshot.lineTax)).toBe(99990);
  });

  it("rejects an overlong externalVariantId", () => {
    expectDomainError(
      () =>
        QuoteLine.create(
        {
          lineId: "line-1",
          type: "product",
          externalVariantId: "x".repeat(201),
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
