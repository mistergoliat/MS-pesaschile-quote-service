/** Only bounded identifiers cross an error-output boundary. Never serialize the error itself. */
const NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError",
  "DatabaseError", "ZodError", "PrincipalRegistryError", "MigrationIntegrityError",
  "MigrationManifestError", "DatabaseTransportConfigError", "OperatorUsageError",
  "CommitOutcomeUnknownError", "ArtifactStoreError", "DocumentRenderError",
  "InvalidIssuedSnapshotError", "UnknownIssuerProfileError", "SnapshotIntegrityError",
  "IssuanceAttemptError", "EmailEnvelopeError", "EmailProviderDisabledError",
  "QuoteNotAcceptedError", "OverrideOutOfRangeError", "InvalidCursorError",
  "QuoteRequestRejected", "HttpError"
]);
const CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
  "EADDRINUSE", "EACCES", "ENOENT", "EPERM", "ENOSPC",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER",
  "DB_URL_INVALID", "DB_URL_POLICY_CONFLICT", "DB_CA_REQUIRED", "DB_CA_INVALID",
  "DB_CA_UNUSED", "DB_PRODUCTION_TRANSPORT_INVALID"
]);

function ownValue(error: unknown, key: string): unknown {
  // Accessors, proxies, and custom toString methods are untrusted too.
  try {
    return typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, key)?.value as unknown
      : undefined;
  } catch {
    return undefined;
  }
}

export function safeErrorSummary(error: unknown): { errorName: string; errorCode: string | null } {
  const name = ownValue(error, "name");
  const code = ownValue(error, "code");
  let errorName = typeof name === "string" && NAMES.has(name) ? name : "unknown";
  if (name === undefined) {
    // Native Error names live on their prototypes; do not read arbitrary inherited properties.
    try {
      if (error instanceof Error) errorName = "Error";
    } catch { /* A hostile proxy is simply unknown. */ }
  }
  return {
    errorName,
    // SQLSTATE is exactly five uppercase alphanumeric characters, starting with a numeric class
    // or PostgreSQL's P/F/HV/XX classes. Other driver/OS identifiers need an explicit allowlist.
    errorCode: typeof code === "string" && (CODES.has(code) || /^(?:[0-9][0-9A-Z]|P[0-9]|F[0-9]|HV|XX)[0-9A-Z]{3}$/.test(code)) ? code : null
  };
}
