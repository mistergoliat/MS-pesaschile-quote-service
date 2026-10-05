import { loadEnv, type AppEnv } from "../../src/infrastructure/config/env";

/**
 * Env with fast, bounded dependency probing so recovery tests finish in
 * seconds. Retry backoff 100ms → 400ms; probe timeout 1s.
 */
export function buildRuntimeTestEnv(input: {
  readonly databaseUrl: string;
  readonly storageRoot: string;
  readonly overrides?: Record<string, string>;
}): AppEnv {
  return loadEnv({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: input.databaseUrl,
    DATABASE_SSL_MODE: "disable",
    DB_POOL_CONNECTION_TIMEOUT_MS: "1000",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-test",
    SERVICE_AUTH_TOKEN: "token",
    HEALTH_PROBE_TIMEOUT_MS: "1000",
    HEALTH_PROBE_INTERVAL_MS: "1000",
    HEALTH_PROBE_RETRY_MIN_MS: "100",
    HEALTH_PROBE_RETRY_MAX_MS: "400",
    QUOTE_COMPANY_NAME: "Pesas Chile SPA",
    QUOTE_DOCUMENT_STORAGE_ROOT: input.storageRoot,
    QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
    QUOTE_RENDER_VERSION: "quote-pdf-v3",
    ...input.overrides
  });
}

/** Polls until `predicate` holds or the deadline passes. */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
