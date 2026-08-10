import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import { MoneyAmount, sumMoney, type SupportedCurrency } from "./money";
import type { QuoteLine } from "./quote-line";

export interface QuotePricingState {
  readonly subtotal: string;
  readonly taxAmount: string;
  readonly total: string;
}

export class QuotePricing {
  readonly #subtotal: MoneyAmount;
  readonly #taxAmount: MoneyAmount;
  readonly #total: MoneyAmount;

  private constructor(state: {
    subtotal: MoneyAmount;
    taxAmount: MoneyAmount;
    total: MoneyAmount;
  }) {
    this.#subtotal = state.subtotal;
    this.#taxAmount = state.taxAmount;
    this.#total = state.total;
  }

  static fromLines(currency: SupportedCurrency, lines: readonly QuoteLine[]): QuotePricing {
    const subtotal = sumMoney(
      currency,
      lines.map((line) => line.lineSubtotal)
    );
    const taxAmount = sumMoney(
      currency,
      lines.map((line) => line.lineTax)
    );
    const total = sumMoney(
      currency,
      lines.map((line) => line.lineTotal)
    );

    return new QuotePricing({
      subtotal,
      taxAmount,
      total
    });
  }

  static rehydrate(
    currency: SupportedCurrency,
    input: QuotePricingState,
    lines: readonly QuoteLine[]
  ): QuotePricing {
    const reCalculated = QuotePricing.fromLines(currency, lines).toSnapshot();

    if (
      input.subtotal !== reCalculated.subtotal ||
      input.taxAmount !== reCalculated.taxAmount ||
      input.total !== reCalculated.total
    ) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteReference,
        "Persisted quote pricing does not reconcile with persisted lines"
      );
    }

    return new QuotePricing({
      subtotal: MoneyAmount.from(currency, input.subtotal, {
        field: "pricing.subtotal",
        code: DOMAIN_ERROR_CODES.invalidMoneyAmount
      }),
      taxAmount: MoneyAmount.from(currency, input.taxAmount, {
        field: "pricing.taxAmount",
        code: DOMAIN_ERROR_CODES.invalidMoneyAmount
      }),
      total: MoneyAmount.from(currency, input.total, {
        field: "pricing.total",
        code: DOMAIN_ERROR_CODES.invalidMoneyAmount
      })
    });
  }

  toSnapshot(): QuotePricingState {
    return {
      subtotal: this.#subtotal.toString(),
      taxAmount: this.#taxAmount.toString(),
      total: this.#total.toString()
    };
  }
}
