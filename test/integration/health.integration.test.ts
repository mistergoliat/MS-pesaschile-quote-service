import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/app";
import type { AppEnv } from "../../src/infrastructure/config/env";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "../helpers/test-database";

describe("GET /health", () => {
  let testDatabase: TestDatabaseHandle;
  let appContext: ReturnType<typeof buildApplication> | undefined;

  beforeAll(async () => {
    testDatabase = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);

    const env: AppEnv = {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 0,
      LOG_LEVEL: "silent",
      DATABASE_URL: testDatabase.connectionString,
      DATABASE_SSL_MODE: "disable",
      SERVICE_NAME: "pesaschile-quote-service",
      SERVICE_VERSION: "0.1.0-test",
      SERVICE_AUTH_TOKEN: "token",
      HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000
    };

    await runMigrations({
      databaseUrl: env.DATABASE_URL,
      direction: "up"
    });

    appContext = buildApplication(env);
  });

  afterAll(async () => {
    if (appContext) {
      await appContext.app.close();
    }

    await testDatabase.dispose();
  });

  it("returns database-backed health information", async () => {
    if (!appContext) {
      throw new Error("Application context was not initialized");
    }

    const response = await appContext.app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      status: "ok",
      service: "pesaschile-quote-service",
      version: "0.1.0-test",
      checks: {
        database: {
          status: "up"
        }
      }
    });
  });
});
