import type { FailureCategory } from "../../../application/health/dependency-state";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT"
]);

// SQLSTATEs that mean "the database cannot serve us right now", as opposed
// to a problem with the statement itself.
const UNAVAILABLE_SQLSTATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "3D000", // invalid_catalog_name (database does not exist)
  "28000", // invalid_authorization_specification
  "28P01" // invalid_password
]);

const SCHEMA_SQLSTATES = new Set([
  "42P01", // undefined_table
  "3F000" // invalid_schema_name
]);

const CONNECTION_MESSAGE_PATTERNS = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection error/i,
  /query read timeout/i,
  /cannot use a pool after calling end/i
];

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** True when the error says the database is unreachable/unusable, not that a statement was wrong. */
export function isDatabaseUnavailableError(error: unknown): boolean {
  const code = errorCode(error);

  if (code !== undefined && (NETWORK_ERROR_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code) || code.startsWith("08"))) {
    return true;
  }

  const message = errorMessage(error);
  return CONNECTION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when a statement failed because the expected relation/schema does not exist. */
export function isSchemaNotReadyError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && SCHEMA_SQLSTATES.has(code);
}

/** Maps a driver/server error to the sanitized contract category. */
export function classifyDatabaseFailure(error: unknown): FailureCategory {
  const code = errorCode(error);

  if (code === "28000" || code === "28P01") {
    return "authentication";
  }

  if (code === "42501") {
    return "permission";
  }

  if (code === "ETIMEDOUT" || /timeout/i.test(errorMessage(error))) {
    return "timeout";
  }

  return "unreachable";
}
