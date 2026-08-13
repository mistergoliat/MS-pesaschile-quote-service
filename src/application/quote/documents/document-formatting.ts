import Decimal from "decimal.js";

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

export function formatClpMoney(value: string): string {
  const normalized = value.trim();
  const isNegative = normalized.startsWith("-");
  const digits = isNegative ? normalized.slice(1) : normalized;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${isNegative ? "-" : ""}$${grouped}`;
}

export function formatQuantityDisplay(value: string): string {
  if (!value.includes(".")) {
    return value;
  }

  return value.replace(/\.?0+$/, "");
}

export function formatCommercialUnitPriceDisplay(input: {
  readonly lineTotal: string;
  readonly quantity: string;
}): string {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.lineTotal).div(quantity).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  return formatClpMoney(unitPrice.toFixed(0));
}

export function formatUtcDateDisplay(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${day}/${month}/${year}`;
}

export function formatUtcShortSpanishDateDisplay(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = SPANISH_SHORT_MONTHS[date.getUTCMonth()] ?? SPANISH_SHORT_MONTHS[0];
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${day} ${month} ${year}`;
}
