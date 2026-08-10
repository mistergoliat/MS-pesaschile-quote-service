import Decimal from "decimal.js";

import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import type { SUPPORTED_CURRENCIES } from "./constants";
import type { DomainErrorCode } from "./errors";
import { parseDecimalInput } from "./shared";

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
export type DecimalInput = Decimal.Value;

interface CurrencyPolicy {
  readonly code: SupportedCurrency;
  readonly minorUnits: number;
  readonly roundingMode: Decimal.Rounding;
}

const CURRENCY_POLICIES: Record<SupportedCurrency, CurrencyPolicy> = {
  CLP: {
    code: "CLP",
    minorUnits: 0,
    roundingMode: Decimal.ROUND_HALF_UP
  }
};

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return value in CURRENCY_POLICIES;
}

export function getCurrencyPolicy(currency: string): CurrencyPolicy {
  if (!isSupportedCurrency(currency)) {
    throw new DomainError(DOMAIN_ERROR_CODES.invalidCurrency, "Unsupported currency", {
      currency
    });
  }

  return CURRENCY_POLICIES[currency];
}

function roundDecimal(currency: SupportedCurrency, value: Decimal): Decimal {
  const policy = getCurrencyPolicy(currency);
  return value.toDecimalPlaces(policy.minorUnits, policy.roundingMode);
}

export class MoneyAmount {
  readonly #currency: SupportedCurrency;
  readonly #amount: Decimal;

  private constructor(currency: SupportedCurrency, amount: Decimal) {
    this.#currency = currency;
    this.#amount = amount;
  }

  static zero(currency: SupportedCurrency): MoneyAmount {
    return MoneyAmount.fromDecimal(currency, new Decimal(0));
  }

  static from(
    currency: SupportedCurrency,
    value: DecimalInput,
    options?: {
      field?: string;
      code?: DomainErrorCode;
    }
  ): MoneyAmount {
    const decimal = parseDecimalInput(value, {
      field: options?.field ?? "money",
      code: options?.code ?? DOMAIN_ERROR_CODES.invalidMoneyAmount
    });

    return MoneyAmount.fromDecimal(currency, decimal);
  }

  static fromDecimal(currency: SupportedCurrency, value: Decimal): MoneyAmount {
    return new MoneyAmount(currency, roundDecimal(currency, value));
  }

  get currency(): SupportedCurrency {
    return this.#currency;
  }

  plus(other: MoneyAmount): MoneyAmount {
    this.assertSameCurrency(other);
    return MoneyAmount.fromDecimal(this.#currency, this.#amount.plus(other.#amount));
  }

  minus(other: MoneyAmount): MoneyAmount {
    this.assertSameCurrency(other);
    return MoneyAmount.fromDecimal(this.#currency, this.#amount.minus(other.#amount));
  }

  multiply(
    multiplier: DecimalInput,
    options?: {
      field?: string;
      code?: DomainErrorCode;
    }
  ): MoneyAmount {
    const decimal = parseDecimalInput(multiplier, {
      field: options?.field ?? "multiplier",
      code: options?.code ?? DOMAIN_ERROR_CODES.invalidMoneyAmount
    });

    return MoneyAmount.fromDecimal(this.#currency, this.#amount.mul(decimal));
  }

  divide(
    divisor: DecimalInput,
    options?: {
      field?: string;
      code?: DomainErrorCode;
    }
  ): MoneyAmount {
    const decimal = parseDecimalInput(divisor, {
      field: options?.field ?? "divisor",
      code: options?.code ?? DOMAIN_ERROR_CODES.invalidMoneyAmount
    });

    if (decimal.isZero()) {
      throw new DomainError(
        options?.code ?? DOMAIN_ERROR_CODES.invalidMoneyAmount,
        `${options?.field ?? "divisor"} must not be zero`,
        {
          field: options?.field ?? "divisor"
        }
      );
    }

    return MoneyAmount.fromDecimal(this.#currency, this.#amount.div(decimal));
  }

  isNegative(): boolean {
    return this.#amount.isNegative();
  }

  equals(other: MoneyAmount): boolean {
    return this.#currency === other.#currency && this.#amount.eq(other.#amount);
  }

  toDecimal(): Decimal {
    return new Decimal(this.#amount);
  }

  toString(): string {
    const policy = getCurrencyPolicy(this.#currency);
    return this.#amount.toFixed(policy.minorUnits);
  }

  toJSON(): string {
    return this.toString();
  }

  assertSameCurrency(other: MoneyAmount): void {
    if (this.#currency !== other.#currency) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidCurrency,
        "Money amounts must use the same currency",
        {
          leftCurrency: this.#currency,
          rightCurrency: other.#currency
        }
      );
    }
  }
}

export function sumMoney(
  currency: SupportedCurrency,
  amounts: readonly MoneyAmount[]
): MoneyAmount {
  let total = MoneyAmount.zero(currency);

  for (const amount of amounts) {
    total = total.plus(amount);
  }

  return total;
}
