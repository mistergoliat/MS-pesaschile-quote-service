import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/app";
import { loadEnv } from "../../src/infrastructure/config/env";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "../helpers/test-database";

interface ManagedApp {
  readonly close: () => Promise<void>;
}

const managedApps: ManagedApp[] = [];
const managedDatabases: TestDatabaseHandle[] = [];
const managedPaths: string[] = [];

afterEach(async () => {
  while (managedApps.length > 0) {
    await managedApps.pop()!.close().catch(() => undefined);
  }

  while (managedDatabases.length > 0) {
    await managedDatabases.pop()!.dispose().catch(() => undefined);
  }

  while (managedPaths.length > 0) {
    await fsPromises.rm(managedPaths.pop()!, {
      recursive: true,
      force: true
    }).catch(() => undefined);
  }
}, 30_000);

async function createBaseEnv() {
  const databaseHandle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-readiness-"));
  managedDatabases.push(databaseHandle);
  managedPaths.push(storageRoot);

  const env = loadEnv({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseHandle.connectionString,
    DATABASE_SSL_MODE: "disable",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-test",
    SERVICE_AUTH_TOKEN: "token",
    HEALTHCHECK_DATABASE_TIMEOUT_MS: "1000",
    QUOTE_COMPANY_NAME: "Pesas Chile SPA",
    QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
    QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
    QUOTE_RENDER_VERSION: "quote-pdf-v3"
  });

  await runMigrations({
    databaseUrl: env.DATABASE_URL,
    direction: "up"
  });

  return {
    env,
    databaseHandle,
    storageRoot
  };
}

describe("Readiness operations", () => {
  it("reports not ready when storage becomes unavailable after startup", async () => {
    const { env, storageRoot } = await createBaseEnv();
    const context = buildApplication(env);
    managedApps.push({
      close: () => context.app.close()
    });
    const baseUrl = await context.app.listen({
      host: env.HOST,
      port: env.PORT
    });

    await fsPromises.rm(storageRoot, {
      recursive: true,
      force: true
    });
    await fsPromises.writeFile(storageRoot, "blocked", "utf8");

    const response = await fetch(`${baseUrl}/health/ready`);
    const body = (await response.json()) as {
      readonly status: string;
      readonly checks: {
        readonly storage: {
          readonly status: string;
        };
      };
    };

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        storage: {
          status: "down"
        }
      }
    });
  }, 30_000);

  it("reports the native PDF renderer as ready without a browser executable", async () => {
    const { env } = await createBaseEnv();
    const appContext = buildApplication(env);
    managedApps.push({
      close: () => appContext.app.close()
    });

    const baseUrl = await appContext.app.listen({
      host: env.HOST,
      port: env.PORT
    });
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = (await response.json()) as { checks: { pdfRenderer: { status: string } } };

    expect(response.status).toBe(200);
    expect(body.checks.pdfRenderer.status).toBe("up");
  }, 30_000);
});
