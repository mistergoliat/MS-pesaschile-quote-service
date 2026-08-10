import Decimal from "decimal.js";

import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from "./errors";

export type TimestampInput = Date | string;

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function ensureNonEmptyText(
  value: string,
  options: {
    field: string;
    maxLength: number;
    code: DomainErrorCode;
    minLength?: number;
    pattern?: RegExp;
  }
): string {
  const normalized = normalizeText(value);
  const minLength = options.minLength ?? 1;

  if (normalized.length < minLength || normalized.length > options.maxLength) {
    throw new DomainError(options.code, `${options.field} length is invalid`, {
      field: options.field,
      minLength,
      maxLength: options.maxLength
    });
  }

  if (options.pattern && !options.pattern.test(normalized)) {
    throw new DomainError(options.code, `${options.field} format is invalid`, {
      field: options.field
    });
  }

  return normalized;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  options: {
    field: string;
    maxLength: number;
    code: DomainErrorCode;
    pattern?: RegExp;
  }
): string | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeText(value);

  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > options.maxLength) {
    throw new DomainError(options.code, `${options.field} length is invalid`, {
      field: options.field,
      maxLength: options.maxLength
    });
  }

  if (options.pattern && !options.pattern.test(normalized)) {
    throw new DomainError(options.code, `${options.field} format is invalid`, {
      field: options.field
    });
  }

  return normalized;
}

export function parseTimestamp(
  value: TimestampInput,
  options: {
    field: string;
    code: DomainErrorCode;
  }
): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new DomainError(options.code, `${options.field} must be a valid timestamp`, {
      field: options.field
    });
  }

  return date.toISOString();
}

export function compareTimestamps(left: string, right: string): number {
  return new Date(left).getTime() - new Date(right).getTime();
}

export function isClosedEnumValue<T extends readonly string[]>(
  values: T,
  candidate: string
): candidate is T[number] {
  return values.includes(candidate);
}

export function parseDecimalInput(
  value: Decimal.Value,
  options: {
    field: string;
    code: DomainErrorCode;
  }
): Decimal {
  try {
    const decimal = new Decimal(value);

    if (!decimal.isFinite()) {
      throw new Error("Non-finite decimal");
    }

    return decimal;
  } catch {
    throw new DomainError(options.code, `${options.field} must be a valid decimal`, {
      field: options.field
    });
  }
}

export function serializeDecimal(value: Decimal): string {
  return value.toFixed();
}

export function assertPositiveInteger(
  value: number,
  options: {
    field: string;
    code?: DomainErrorCode;
  }
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError(
      options.code ?? DOMAIN_ERROR_CODES.invalidQuoteReference,
      `${options.field} must be a positive integer`,
      {
        field: options.field
      }
    );
  }
}
