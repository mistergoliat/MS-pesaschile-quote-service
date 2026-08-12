import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/infrastructure/config/env";

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
      SERVICE_AUTH_TOKEN: "token",
      HEALTHCHECK_DATABASE_TIMEOUT_MS: "1500",
      QUOTE_COMPANY_NAME: "Pesas Chile SPA",
      QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
      QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
      QUOTE_RENDER_VERSION: "quote-v1",
      QUOTE_PDF_RENDER_TIMEOUT_MS: "15000",
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
        SERVICE_AUTH_TOKEN: "token",
        QUOTE_DOCUMENT_STORAGE_ROOT: "C:/temp/test-documents",
        QUOTE_DOCUMENT_REF_SECRET: "test-document-secret"
      })
    ).toThrow();
  });
});
