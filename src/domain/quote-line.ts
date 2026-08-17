import Decimal from "decimal.js";

import { DOMAIN_LIMITS, QUOTE_LINE_TYPES } from "./constants";
import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import {
  MoneyAmount,
  type DecimalInput,
  type SupportedCurrency
} from "./money";
import {
  ensureNonEmptyText,
  isClosedEnumValue,
  normalizeOptionalText,
  parseDecimalInput,
  serializeDecimal
} from "./shared";

export type QuoteLineType = (typeof QUOTE_LINE_TYPES)[number];

export interface QuoteLineInput {
  readonly lineId: string;
  readonly type: QuoteLineType;
  /**
   * SALES-AGENT-R1-T1.1. Generic external identity references, never a
   * requirement for every line (type=service or a legacy/manual line may
   * carry none of the three, all null). When present, they identify the
   * exact same catalog product/variant CRM's own durable selection already
   * resolved - never concatenated, never parsed heuristically here or
   * anywhere downstream.
   */
  readonly externalSource?: string | null;
  readonly externalItemId?: string | null;
  readonly externalVariantId?: string | null;
  readonly sku?: string | null;
  readonly description: string;
  readonly quantity: DecimalInput;
  readonly unitPrice: DecimalInput;
  readonly taxIncluded: boolean;
  readonly taxRate: DecimalInput;
}

export interface QuoteLineState {
  readonly lineId: string;
  readonly type: QuoteLineType;
  readonly externalSource: string | null;
  readonly externalItemId: string | null;
  readonly externalVariantId: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxIncluded: boolean;
  readonly taxRate: string;
  readonly lineSubtotal: string;
  readonly lineTax: string;
  readonly lineTotal: string;
}

export class QuoteLine {
  readonly #lineId: string;
  readonly #type: QuoteLineType;
  readonly #externalSource: string | null;
  readonly #externalItemId: string | null;
  readonly #externalVariantId: string | null;
  readonly #sku: string | null;
  readonly #description: string;
  readonly #quantity: Decimal;
  readonly #unitPrice: MoneyAmount;
  readonly #taxIncluded: boolean;
  readonly #taxRate: Decimal;
  readonly #lineSubtotal: MoneyAmount;
  readonly #lineTax: MoneyAmount;
  readonly #lineTotal: MoneyAmount;

  private constructor(state: {
    lineId: string;
    type: QuoteLineType;
    externalSource: string | null;
    externalItemId: string | null;
    externalVariantId: string | null;
    sku: string | null;
    description: string;
    quantity: Decimal;
    unitPrice: MoneyAmount;
    taxIncluded: boolean;
    taxRate: Decimal;
    lineSubtotal: MoneyAmount;
    lineTax: MoneyAmount;
    lineTotal: MoneyAmount;
  }) {
    this.#lineId = state.lineId;
    this.#type = state.type;
    this.#externalSource = state.externalSource;
    this.#externalItemId = state.externalItemId;
    this.#externalVariantId = state.externalVariantId;
    this.#sku = state.sku;
    this.#description = state.description;
    this.#quantity = state.quantity;
    this.#unitPrice = state.unitPrice;
    this.#taxIncluded = state.taxIncluded;
    this.#taxRate = state.taxRate;
    this.#lineSubtotal = state.lineSubtotal;
    this.#lineTax = state.lineTax;
    this.#lineTotal = state.lineTotal;
  }

  static create(input: QuoteLineInput, currency: SupportedCurrency): QuoteLine {
    if (!isClosedEnumValue(QUOTE_LINE_TYPES, input.type)) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteReference,
        "quote line type is invalid",
        {
          field: "items.type"
        }
      );
    }

    const lineId = ensureNonEmptyText(input.lineId, {
      field: "items.lineId",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference,
      maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
    });

    const quantity = parseDecimalInput(input.quantity, {
      field: "items.quantity",
      code: DOMAIN_ERROR_CODES.invalidLineQuantity
    });

    if (quantity.lte(0)) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidLineQuantity,
        "items.quantity must be greater than zero",
        {
          field: "items.quantity"
        }
      );
    }

    const unitPrice = MoneyAmount.from(currency, input.unitPrice, {
      field: "items.unitPrice",
      code: DOMAIN_ERROR_CODES.invalidLinePrice
    });

    if (unitPrice.isNegative()) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidLinePrice,
        "items.unitPrice must not be negative",
        {
          field: "items.unitPrice"
        }
      );
    }

    const taxRate = parseDecimalInput(input.taxRate, {
      field: "items.taxRate",
      code: DOMAIN_ERROR_CODES.invalidTaxRate
    });

    if (taxRate.isNegative()) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidTaxRate,
        "items.taxRate must not be negative",
        {
          field: "items.taxRate"
        }
      );
    }

    const lineAmounts = QuoteLine.calculateAmounts({
      currency,
      quantity,
      unitPrice,
      taxIncluded: input.taxIncluded,
      taxRate
    });

    return new QuoteLine({
      lineId,
      type: input.type,
      externalSource: normalizeOptionalText(input.externalSource, {
        field: "items.externalSource",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.quoteLine.maxExternalSourceLength
      }),
      externalItemId: normalizeOptionalText(input.externalItemId, {
        field: "items.externalItemId",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.quoteLine.maxExternalItemIdLength
      }),
      externalVariantId: normalizeOptionalText(input.externalVariantId, {
        field: "items.externalVariantId",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.quoteLine.maxExternalVariantIdLength
      }),
      sku: normalizeOptionalText(input.sku, {
        field: "items.sku",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.quoteLine.maxSkuLength
      }),
      description: ensureNonEmptyText(input.description, {
        field: "items.description",
        code: DOMAIN_ERROR_CODES.invalidQuoteReference,
        maxLength: DOMAIN_LIMITS.quoteLine.maxDescriptionLength
      }),
      quantity,
      unitPrice,
      taxIncluded: input.taxIncluded,
      taxRate,
      lineSubtotal: lineAmounts.lineSubtotal,
      lineTax: lineAmounts.lineTax,
      lineTotal: lineAmounts.lineTotal
    });
  }

  static rehydrate(input: QuoteLineState, currency: SupportedCurrency): QuoteLine {
    const quantity = parseDecimalInput(input.quantity, {
      field: "items.quantity",
      code: DOMAIN_ERROR_CODES.invalidLineQuantity
    });
    const unitPrice = MoneyAmount.from(currency, input.unitPrice, {
      field: "items.unitPrice",
      code: DOMAIN_ERROR_CODES.invalidLinePrice
    });
    const taxRate = parseDecimalInput(input.taxRate, {
      field: "items.taxRate",
      code: DOMAIN_ERROR_CODES.invalidTaxRate
    });

    const hydrated = QuoteLine.create(
      {
        lineId: input.lineId,
        type: input.type,
        externalSource: input.externalSource,
        externalItemId: input.externalItemId,
        externalVariantId: input.externalVariantId,
        sku: input.sku,
        description: input.description,
        quantity,
        unitPrice: input.unitPrice,
        taxIncluded: input.taxIncluded,
        taxRate
      },
      currency
    );

    const snapshot = hydrated.toSnapshot();

    if (
      snapshot.lineSubtotal !== input.lineSubtotal ||
      snapshot.lineTax !== input.lineTax ||
      snapshot.lineTotal !== input.lineTotal
    ) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteReference,
        "Persisted quote line totals do not reconcile with their inputs",
        {
          lineId: input.lineId
        }
      );
    }

    return new QuoteLine({
      lineId: snapshot.lineId,
      type: snapshot.type,
      externalSource: snapshot.externalSource,
      externalItemId: snapshot.externalItemId,
      externalVariantId: snapshot.externalVariantId,
      sku: snapshot.sku,
      description: snapshot.description,
      quantity,
      unitPrice,
      taxIncluded: snapshot.taxIncluded,
      taxRate,
      lineSubtotal: MoneyAmount.from(currency, snapshot.lineSubtotal),
      lineTax: MoneyAmount.from(currency, snapshot.lineTax),
      lineTotal: MoneyAmount.from(currency, snapshot.lineTotal)
    });
  }

  static calculateAmounts(input: {
    currency: SupportedCurrency;
    quantity: Decimal;
    unitPrice: MoneyAmount;
    taxIncluded: boolean;
    taxRate: Decimal;
  }): {
    lineSubtotal: MoneyAmount;
    lineTax: MoneyAmount;
    lineTotal: MoneyAmount;
  } {
    if (input.taxIncluded) {
      const lineTotal = input.unitPrice.multiply(input.quantity);
      const divisor = new Decimal(1).plus(input.taxRate);
      const lineSubtotal = lineTotal.divide(divisor, {
        field: "items.taxRate",
        code: DOMAIN_ERROR_CODES.invalidTaxRate
      });
      const lineTax = lineTotal.minus(lineSubtotal);

      return {
        lineSubtotal,
        lineTax,
        lineTotal
      };
    }

    const lineSubtotal = input.unitPrice.multiply(input.quantity);
    const lineTax = lineSubtotal.multiply(input.taxRate, {
      field: "items.taxRate",
      code: DOMAIN_ERROR_CODES.invalidTaxRate
    });
    const lineTotal = lineSubtotal.plus(lineTax);

    return {
      lineSubtotal,
      lineTax,
      lineTotal
    };
  }

  get lineSubtotal(): MoneyAmount {
    return this.#lineSubtotal;
  }

  get lineTax(): MoneyAmount {
    return this.#lineTax;
  }

  get lineTotal(): MoneyAmount {
    return this.#lineTotal;
  }

  toSnapshot(): QuoteLineState {
    return {
      lineId: this.#lineId,
      type: this.#type,
      externalSource: this.#externalSource,
      externalItemId: this.#externalItemId,
      externalVariantId: this.#externalVariantId,
      sku: this.#sku,
      description: this.#description,
      quantity: serializeDecimal(this.#quantity),
      unitPrice: this.#unitPrice.toString(),
      taxIncluded: this.#taxIncluded,
      taxRate: serializeDecimal(this.#taxRate),
      lineSubtotal: this.#lineSubtotal.toString(),
      lineTax: this.#lineTax.toString(),
      lineTotal: this.#lineTotal.toString()
    };
  }
}
