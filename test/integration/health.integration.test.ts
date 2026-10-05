import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/app";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { buildRuntimeTestEnv } from "../helpers/runtime-test-env";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "../helpers/test-database";

describe("health endpoints", () => {
  let testDatabase: TestDatabaseHandle;
  let appContext: ReturnType<typeof buildApplication> | undefined;
  let storageRoot: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-documents-health-"));
    await runMigrations({
      databaseUrl: testDatabase.connectionString,
      direction: "up"
    });

    appContext = buildApplication(
      buildRuntimeTestEnv({
        databaseUrl: testDatabase.connectionString,
        storageRoot,
        // Keep the background cadence out of the way: only explicit probes run.
        overrides: { HEALTH_PROBE_INTERVAL_MS: "300000" }
      })
    );
    await appContext.app.ready();
  }, 30_000);

  afterAll(async () => {
    if (appContext) {
      await appContext.app.close();
    }

    await testDatabase.dispose();
    await fsPromises.rm(storageRoot, {
      recursive: true,
      force: true
    });
  }, 30_000);

  function context() {
    if (!appContext) {
      throw new Error("Application context was not initialized");
    }

    return appContext;
  }

  it("GET /health/live answers without dependency checks", async () => {
    const response = await context().app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("GET /health is a deprecated liveness alias", async () => {
    const response = await context().app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "pesaschile-quote-service",
      version: "0.1.0-test"
    });
  });

  it("GET /health/ready reports only ok/fail per check", async () => {
    const response = await context().app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: {
        database: "ok",
        schema: "ok",
        artifactStorage: "ok",
        renderer: "ok",
        lifecycle: "ok"
      }
    });
    expect(response.body).not.toContain("test-document-secret");
    expect(response.body).not.toContain(storageRoot);
  });

  it("health requests read cached state and never trigger probes", async () => {
    const probeSpy = vi.spyOn(context().dependencyMonitor, "probeNow");

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        context().app.inject({
          method: "GET",
          url: ["/health/live", "/health/ready", "/health"][index % 3]!
        })
      )
    );
    await context().app.inject({
      method: "GET",
      url: "/health/dependencies",
      headers: { authorization: "Bearer token" }
    });

    expect(probeSpy).not.toHaveBeenCalled();
    probeSpy.mockRestore();
  });

  it("GET /health/dependencies requires service authentication", async () => {
    const missing = await context().app.inject({ method: "GET", url: "/health/dependencies" });
    const invalid = await context().app.inject({
      method: "GET",
      url: "/health/dependencies",
      headers: { authorization: "Bearer wrong" }
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
  });

  it("reports not ready while shutting down", async () => {
    context().lifecycleState.markShuttingDown();
    const response = await context().app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { lifecycle: "fail", database: "ok" }
    });

    const live = await context().app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
  });
});
