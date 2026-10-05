import crypto from "node:crypto";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function normalizeValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalizedEntries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const candidate = record[key];

        if (candidate === undefined) {
          return [];
        }

        return [[key, normalizeValue(candidate)] as const];
      });

    return Object.fromEntries(normalizedEntries);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return null;
}

export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

export function createCanonicalRequestHash(value: unknown): string {
  return crypto.createHash("sha256").update(toCanonicalJson(value)).digest("hex");
}

/**
 * RFC 8785 (JCS) serialization for JSON values: object keys sorted by UTF-16
 * code units, ES number/string serialization (identical to JSON.stringify).
 * Builds the string directly, because JS objects order integer-like keys
 * numerically, which JCS does not.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcs).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(record[key])}`)
    .join(",")}}`;
}

export function sha256Jcs(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalizeJcs(value), "utf8").digest("hex");
}
