/*
 * Pure display formatters shared by the V2 formal PDF and the legacy email
 * (string handling only: no arithmetic, no locale, no Date).
 */

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
