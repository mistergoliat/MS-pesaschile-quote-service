/**
 * Normative charge arithmetic (docs/v2/QUOTE_V2_DOMAIN_CONTRACT.md §6.3).
 * Exact integers only: Q = quantity × 10⁶, R = taxRate × 10⁶,
 * halfUp(n, d) = floor((2n + d) / (2d)). Rounding happens only per charge;
 * totals are sums of rounded charge amounts.
 */

export type TaxBasis = "included" | "excluded" | "exempt";

export interface ChargeAmounts {
  readonly net: bigint;
  readonly tax: bigint;
  readonly gross: bigint;
}

export interface Totals extends ChargeAmounts {
  readonly exemptNet: bigint;
}

const SCALE = 1_000_000n;
/** Largest contract `ClpAmount` (2⁵³ − 1). */
export const MAX_CLP_AMOUNT = 9_007_199_254_740_991n;

/** Canonical decimal string with ≤ 6 fractional digits → value × 10⁶. */
export function scaleDecimal(decimal: string): bigint {
  const [integer, fraction = ""] = decimal.split(".");
  return BigInt(integer!) * SCALE + BigInt((fraction + "000000").slice(0, 6));
}

const halfUp = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);

export function chargeAmounts(unitAmount: number, quantity: string, basis: TaxBasis, taxRate?: string): ChargeAmounts {
  const extension = halfUp(BigInt(unitAmount) * scaleDecimal(quantity), SCALE);

  if (basis === "exempt") {
    return { net: extension, tax: 0n, gross: extension };
  }

  const rate = scaleDecimal(taxRate!);

  if (basis === "included") {
    const net = halfUp(extension * SCALE, SCALE + rate);
    return { net, tax: extension - net, gross: extension };
  }

  const tax = halfUp(extension * rate, SCALE);
  return { net: extension, tax, gross: extension + tax };
}

export function sumTotals(charges: ReadonlyArray<{ readonly amounts: ChargeAmounts; readonly basis: TaxBasis }>): Totals {
  return charges.reduce<Totals>(
    (totals, { amounts, basis }) => ({
      net: totals.net + amounts.net,
      tax: totals.tax + amounts.tax,
      gross: totals.gross + amounts.gross,
      exemptNet: totals.exemptNet + (basis === "exempt" ? amounts.net : 0n)
    }),
    { net: 0n, tax: 0n, gross: 0n, exemptNet: 0n }
  );
}

/** Canonical decimal string from a stored numeric ("2.500000" → "2.5"). */
export function canonicalDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
