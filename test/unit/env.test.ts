import { describe, expect, it } from "vitest";

import {
  describeConfigError,
  issuanceSettings,
  loadEnv,
  loadMigrationEnv
} from "../../src/infrastructure/config/env";

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://app:app-secret-password@db.internal:5432/quotes",
  QUOTE_PRINCIPAL_REGISTRY_JSON: "{}",
  QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
};

describe("runtime health configuration", () => {
  it("defaults probe cadence and falls back to the deprecated database timeout key", () => {
    const env = loadEnv({ ...MINIMAL_ENV, HEALTHCHECK_DATABASE_TIMEOUT_MS: "1500" });

    expect(env.HEALTH_PROBE_TIMEOUT_MS).toBe(1500);
    expect(env.HEALTH_PROBE_INTERVAL_MS).toBe(10_000);
    expect(env.HEALTH_PROBE_RETRY_MIN_MS).toBe(1_000);
    expect(env.HEALTH_PROBE_RETRY_MAX_MS).toBe(30_000);
  });

  it("prefers HEALTH_PROBE_TIMEOUT_MS when both keys are set", () => {
    const env = loadEnv({
      ...MINIMAL_ENV,
      HEALTHCHECK_DATABASE_TIMEOUT_MS: "1500",
      HEALTH_PROBE_TIMEOUT_MS: "800"
    });

    expect(env.HEALTH_PROBE_TIMEOUT_MS).toBe(800);
  });

  it("rejects a retry floor above the retry cap", () => {
    expect(() =>
      loadEnv({ ...MINIMAL_ENV, HEALTH_PROBE_RETRY_MIN_MS: "5000", HEALTH_PROBE_RETRY_MAX_MS: "1000" })
    ).toThrow();
  });

  it("describes configuration errors without echoing values", () => {
    let caught: unknown;

    try {
      loadEnv({ ...MINIMAL_ENV, DATABASE_URL: "not-a-url-with-secret-sauce" });
    } catch (error) {
      caught = error;
    }

    const description = describeConfigError(caught);
    expect(description?.issues.map((issue) => issue.path)).toContain("DATABASE_URL");
    expect(JSON.stringify(description)).not.toContain("secret-sauce");
    expect(describeConfigError(new Error("other"))).toBeNull();
  });
});

describe("loadMigrationEnv", () => {
  it("uses MIGRATION_DATABASE_URL when present and needs no runtime secrets", () => {
    expect(
      loadMigrationEnv({
        DATABASE_URL: "postgres://app@db/quotes",
        MIGRATION_DATABASE_URL: "postgres://migrator@db/quotes"
      })
    ).toEqual({ databaseUrl: "postgres://migrator@db/quotes" });
  });

  it("falls back to DATABASE_URL and fails without either", () => {
    expect(loadMigrationEnv({ DATABASE_URL: "postgres://app@db/quotes" })).toEqual({
      databaseUrl: "postgres://app@db/quotes"
    });
    expect(() => loadMigrationEnv({})).toThrow();
  });
});

describe("loadEnv", () => {
  it("parses a valid environment", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "3001",
      LOG_LEVEL: "debug",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/testdb",
      DATABASE_SSL_MODE: "disable",
      SERVICE_NAME: "service",
      SERVICE_VERSION: "1.0.0",
      QUOTE_PRINCIPAL_REGISTRY_JSON: "{}",
      HEALTHCHECK_DATABASE_TIMEOUT_MS: "1500",
      QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
      QUOTE_EMAIL_PROVIDER: "gmail",
      GOOGLE_GMAIL_CLIENT_ID: "gmail-client-id",
      GOOGLE_GMAIL_CLIENT_SECRET: "gmail-client-secret",
      GOOGLE_GMAIL_REFRESH_TOKEN: "gmail-refresh-token",
      GOOGLE_GMAIL_USER: "quotes@pesaschile.cl",
      QUOTE_EMAIL_FROM_ADDRESS: "quotes@pesaschile.cl",
      QUOTE_EMAIL_FROM_NAME: "Pesas Chile"
    });

    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_SSL_MODE).toBe("disable");
    expect(env.QUOTE_EMAIL_PROVIDER).toBe("gmail");
  });

  it("rejects an invalid database url", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "not-a-url",
        QUOTE_PRINCIPAL_REGISTRY_JSON: "{}",
        QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
      })
    ).toThrow();
  });
});

describe("issuance configuration (Idempotency §4.2)", () => {
  it("defaults to the contract defaults", () => {
    expect(issuanceSettings(loadEnv(MINIMAL_ENV))).toEqual({
      leaseMs: 60_000,
      pollIntervalMs: 2_000,
      deadlineMs: 86_400_000,
      syncBudgetMs: 5_000
    });
  });

  it.each([
    ["QUOTE_ISSUANCE_LEASE_MS", "10000", "300000", "9999", "300001"],
    ["QUOTE_ISSUANCE_POLL_INTERVAL_MS", "500", "60000", "499", "60001"],
    ["QUOTE_ISSUANCE_DEADLINE_MS", "3600000", "259200000", "3599999", "259200001"],
    ["QUOTE_ISSUANCE_SYNC_BUDGET_MS", "0", "10000", "-1", "10001"]
  ])("%s accepts [%s, %s] and rejects %s and %s", (key, min, max, below, above) => {
    expect(() => loadEnv({ ...MINIMAL_ENV, [key]: min })).not.toThrow();
    expect(() => loadEnv({ ...MINIMAL_ENV, [key]: max })).not.toThrow();
    expect(() => loadEnv({ ...MINIMAL_ENV, [key]: below })).toThrow();
    expect(() => loadEnv({ ...MINIMAL_ENV, [key]: above })).toThrow();
    expect(() => loadEnv({ ...MINIMAL_ENV, [key]: `${min}.5` })).toThrow();
  });
});
