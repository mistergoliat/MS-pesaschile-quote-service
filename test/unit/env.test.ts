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
      HEALTHCHECK_DATABASE_TIMEOUT_MS: "1500"
    });

    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_SSL_MODE).toBe("disable");
  });

  it("rejects an invalid database url", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "not-a-url",
        SERVICE_AUTH_TOKEN: "token"
      })
    ).toThrow();
  });
});
