import { sumMoney, type MoneyAmount, type SupportedCurrency } from "./money";
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

  toSnapshot(): QuotePricingState {
    return {
      subtotal: this.#subtotal.toString(),
      taxAmount: this.#taxAmount.toString(),
      total: this.#total.toString()
    };
  }
}
