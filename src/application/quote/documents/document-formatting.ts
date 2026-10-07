import Decimal from "decimal.js";

import { formatClpMoney } from "./display-formatting";

// Shared display formatters live in display-formatting.ts (also used by the V2 formal PDF).
export { formatClpMoney, formatQuantityDisplay } from "./display-formatting";

const SPANISH_SHORT_MONTHS = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC"
] as const;

/** LEGACY (R1.6 email only): derives a unit price from a V1 line total. Never used by the V2 PDF, which displays the frozen unit amount. */
export function formatCommercialUnitPriceDisplay(input: {
  readonly lineTotal: string;
  readonly quantity: string;
}): string {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.lineTotal).div(quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  return formatClpMoney(unitPrice.toFixed(0));
}

export function formatUtcShortSpanishDateDisplay(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = SPANISH_SHORT_MONTHS[date.getUTCMonth()] ?? SPANISH_SHORT_MONTHS[0];
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${day} ${month} ${year}`;
}
