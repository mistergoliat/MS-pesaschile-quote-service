import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type ApplicationContext, type BuildApplicationOverrides } from "../../src/app";
import type { BusinessRouteRegistrar } from "../../src/http/routes";
import { probeFailed } from "../../src/application/health/dependency-state";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { EXPECTED_SCHEMA_HEAD } from "../../src/infrastructure/persistence/postgres/schema-head";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";
import { createTestDatabase, type TestDatabaseHandle } from "../helpers/test-database";
import { ToggleableTcpProxy } from "../helpers/toggleable-tcp-proxy";

const TEST_TIMEOUT_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

interface Harness {
  readonly context: ApplicationContext;
  readonly baseUrl: string;
  readonly database: TestDatabaseHandle;
  readonly storageRoot: string;
  readonly proxy: ToggleableTcpProxy;
  get(pathname: string, auth?: boolean): Promise<{ status: number; body: unknown; text: string; headers: Headers }>;
  post(pathname: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown; headers: Headers }>;
}

async function startHarness(options: {
  readonly migrate?: boolean;
  readonly proxyEnabled?: boolean;
  readonly envOverrides?: Record<string, string>;
  readonly appOverrides?: BuildApplicationOverrides;
  /** Resolves the gated test route POST /probe/hang. */
  readonly hang?: Promise<void>;
} = {}): Promise<Harness> {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-runtime-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));

  if (options.migrate ?? true) {
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  }

  const target = new URL(database.connectionString);
  const proxy = await ToggleableTcpProxy.create(target.hostname, Number(target.port || 5432));
  cleanups.push(() => proxy.dispose());

  if (options.proxyEnabled === false) {
    await proxy.disable();
  }

  const env = buildRuntimeTestEnv({
    databaseUrl: proxy.route(database.connectionString),
    storageRoot,
    ...(options.envOverrides ? { overrides: options.envOverrides } : {})
  });
  // The V1 business routes were retired in R1.4 and V2 routes arrive in
  // R1.5, so the readiness gate is exercised through test-only business
  // routes mounted in the same gated context. GET /probe/quotes reads the V2
  // quotes table through the request pool.
  const holder: { context?: ApplicationContext } = {};
  const probeRoutes: BusinessRouteRegistrar = (businessApp) => {
    businessApp.get("/probe/quotes", { config: { requiredScope: "quotes:read" } }, async () => {
      const result = await holder.context!.database.query<{ count: number }>(
        "select count(*)::int as count from quote_service.quotes"
      );
      return { quotes: result.rows[0]!.count };
    });
    businessApp.post("/probe/hang", { config: { requiredScope: "quotes:read" } }, async () => {
      await options.hang;
      return { done: true };
    });
  };
  const context = buildApplication(env, {
    ...options.appOverrides,
    businessRoutes: [probeRoutes, ...(options.appOverrides?.businessRoutes ?? [])]
  });
  holder.context = context;
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const baseUrl = await context.app.listen({ host: env.HOST, port: env.PORT });

  return {
    context,
    baseUrl,
    database,
    storageRoot,
    proxy,
    async get(pathname, auth = false) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers: auth ? { Authorization: bearer(TEST_TOKENS.monitoring) } : {}
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, text, headers: response.headers };
    },
    async post(pathname, body, headers = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { Authorization: bearer(TEST_TOKENS.monitoring), "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    }
  };
}

async function readyStatus(harness: Harness): Promise<number> {
  return (await harness.get("/health/ready")).status;
}

describe("runtime reliability: database outage and recovery", () => {
  it("A+B: starts live/not-ready with the database down, then becomes ready without restart", async () => {
    const harness = await startHarness({ proxyEnabled: false });

    const live = await harness.get("/health/live");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: "live" });

    const ready = await harness.get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({
      status: "not_ready",
      checks: { database: "fail", schema: "fail", artifactStorage: "ok", renderer: "ok", lifecycle: "ok" }
    });

    // Business traffic fails closed with a contract error, not a raw driver error.
    const list = await harness.get("/probe/quotes", true);
    expect(list.status).toBe(503);
    expect(list.headers.get("retry-after")).toBe("5");
    expect(list.body).toEqual({
      error: {
        code: "dependency_unavailable",
        message: "A required dependency is unavailable; nothing was committed.",
        requestId: expect.any(String) as string,
        details: { dependency: "database", retryable: true }
      }
    });

    // Several retry cycles pass; the process/app stays up.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await harness.get("/health/live")).status).toBe(200);

    await harness.proxy.enable();
    await waitFor(async () => (await readyStatus(harness)) === 200, 10_000);

    expect((await harness.get("/health/ready")).body).toEqual({
      status: "ready",
      checks: { database: "ok", schema: "ok", artifactStorage: "ok", renderer: "ok", lifecycle: "ok" }
    });
    expect((await harness.get("/probe/quotes", true)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("C: loses the database after ready, stays live, then recovers without restart", async () => {
    const harness = await startHarness();
    expect(await readyStatus(harness)).toBe(200);

    // Warm the pool so idle clients exist when the connection drops: their
    // 'error' events must be absorbed, not crash the process.
    expect((await harness.get("/probe/quotes", true)).status).toBe(200);

    await harness.proxy.disable();
    await waitFor(async () => (await readyStatus(harness)) === 503, 10_000);

    expect((await harness.get("/health/live")).status).toBe(200);
    const duringOutage = await harness.get("/probe/quotes", true);
    expect(duringOutage.status).toBe(503);
    expect((duringOutage.body as { error: { code: string } }).error.code).toBe("dependency_unavailable");

    await harness.proxy.enable();
    await waitFor(async () => (await readyStatus(harness)) === 200, 10_000);

    const afterRecovery = await harness.get("/probe/quotes", true);
    expect(afterRecovery.status).toBe(200);
    expect(afterRecovery.body).toEqual({ quotes: 0 });
  }, TEST_TIMEOUT_MS);

  it("maps a request that races an outage past the gate to 503, not 500", async () => {
    const harness = await startHarness();
    expect(await readyStatus(harness)).toBe(200);

    // Cut the database without letting the monitor observe it first.
    await harness.context.dependencyMonitor.stop();
    await harness.proxy.disable();

    const response = await harness.get("/probe/quotes", true);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "dependency_unavailable" } });
    expect(response.text).not.toContain("ECONNREFUSED");
    expect(response.text).not.toContain("127.0.0.1");
  }, TEST_TIMEOUT_MS);
});

describe("runtime reliability: schema head", () => {
  async function schemaBody(harness: Harness) {
    return (await harness.get("/health/dependencies", true)).body as {
      schema: { expectedHead: string; actualHead: string | null };
      dependencies: { database: { status: string; failureCategory: string | null } };
    };
  }

  it("D: schema missing → not ready, business 503 schema_not_ready", async () => {
    const harness = await startHarness({ migrate: false });

    const ready = await harness.get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ checks: { database: "ok", schema: "fail" } });

    const list = await harness.get("/probe/quotes", true);
    expect(list.status).toBe(503);
    expect(list.body).toMatchObject({ error: { code: "schema_not_ready" } });

    const details = await schemaBody(harness);
    expect(details.schema).toEqual({ expectedHead: EXPECTED_SCHEMA_HEAD, actualHead: null });
    expect(details.dependencies.database).toMatchObject({ status: "degraded", failureCategory: "schema_mismatch" });
    expect(harness.context.dependencyMonitor.details().schema.state).toBe("SCHEMA_MISSING");
  }, TEST_TIMEOUT_MS);

  it("E: schema behind → not ready schema_not_ready; migrating forward recovers without restart", async () => {
    const harness = await startHarness();
    await runMigrations({ databaseUrl: harness.database.connectionString, direction: "down" });
    await harness.context.dependencyMonitor.probeNow();

    expect(await readyStatus(harness)).toBe(503);
    expect((await harness.get("/probe/quotes", true)).body).toMatchObject({ error: { code: "schema_not_ready" } });
    expect(harness.context.dependencyMonitor.details().schema.state).toBe("SCHEMA_BEHIND");
    expect((await schemaBody(harness)).schema.actualHead).toBe("000008_quote_v2_runtime_grants");

    await runMigrations({ databaseUrl: harness.database.connectionString, direction: "up" });
    await waitFor(async () => (await readyStatus(harness)) === 200, 10_000);
  }, TEST_TIMEOUT_MS);

  it("schema ahead/unknown → not ready", async () => {
    const harness = await startHarness();
    const client = new pg.Client({ connectionString: harness.database.connectionString });
    await client.connect();
    await client.query("insert into public.schema_migrations (name, run_on) values ('000099_from_the_future', now())");
    await client.end();
    await harness.context.dependencyMonitor.probeNow();

    expect(await readyStatus(harness)).toBe(503);
    expect(harness.context.dependencyMonitor.details().schema.state).toBe("SCHEMA_AHEAD_OR_UNKNOWN");
    expect((await schemaBody(harness)).schema.actualHead).toBe("000099_from_the_future");
  }, TEST_TIMEOUT_MS);

  it("F: expected head → schema passes", async () => {
    const harness = await startHarness();

    expect((await harness.get("/health/ready")).body).toMatchObject({ checks: { schema: "ok", database: "ok" } });
    const details = await schemaBody(harness);
    expect(details.schema).toEqual({ expectedHead: EXPECTED_SCHEMA_HEAD, actualHead: EXPECTED_SCHEMA_HEAD });
    expect(details.dependencies.database).toMatchObject({ status: "up", failureCategory: null });
  }, TEST_TIMEOUT_MS);
});

describe("runtime reliability: storage and renderer", () => {
  it("G: storage unavailable → not ready; restoring it recovers; probes leave no files", async () => {
    const harness = await startHarness();
    expect(await readyStatus(harness)).toBe(200);
    expect(await fsPromises.readdir(path.join(harness.storageRoot, ".health"))).toEqual([]);

    await fsPromises.rm(harness.storageRoot, { recursive: true, force: true });
    await fsPromises.writeFile(harness.storageRoot, "blocked", "utf8");
    await harness.context.dependencyMonitor.probeNow();

    expect((await harness.get("/health/ready")).body).toMatchObject({
      status: "not_ready",
      checks: { artifactStorage: "fail", database: "ok" }
    });
    expect((await harness.get("/probe/quotes", true)).body).toMatchObject({
      error: { code: "dependency_unavailable", details: { dependency: "artifactStorage" } }
    });

    await fsPromises.rm(harness.storageRoot, { force: true });
    await fsPromises.mkdir(harness.storageRoot);
    await waitFor(async () => (await readyStatus(harness)) === 200, 10_000);
  }, TEST_TIMEOUT_MS);

  it("H: renderer unavailable → not ready, business 503", async () => {
    const harness = await startHarness({
      appOverrides: {
        pdfRenderer: {
          rendererVersion: "test-broken-renderer",
          renderPdf: () => Promise.reject(new Error("renderer broken")),
          probe: () => Promise.resolve(probeFailed("renderer_unavailable"))
        }
      }
    });

    expect((await harness.get("/health/ready")).body).toMatchObject({
      status: "not_ready",
      checks: { renderer: "fail", database: "ok", schema: "ok", artifactStorage: "ok" }
    });
    expect((await harness.get("/probe/quotes", true)).body).toMatchObject({
      error: { code: "dependency_unavailable", details: { dependency: "renderer" } }
    });
  }, TEST_TIMEOUT_MS);
});

describe("runtime reliability: diagnostics", () => {
  it("I: dependency details are authenticated, contract-shaped and sanitized", async () => {
    const harness = await startHarness({ proxyEnabled: false });
    const databaseUrl = harness.proxy.route(harness.database.connectionString);

    expect((await harness.get("/health/dependencies")).status).toBe(401);

    const response = await harness.get("/health/dependencies", true);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body as object).sort()).toEqual(["dependencies", "schema", "service", "workers"]);
    expect(response.body).toMatchObject({
      service: { name: "pesaschile-quote-service", version: "0.1.0-test" },
      schema: { expectedHead: EXPECTED_SCHEMA_HEAD, actualHead: null },
      dependencies: {
        database: { status: "down", failureCategory: "unreachable", lastSuccessAt: null },
        artifactStorage: { status: "up", failureCategory: null },
        renderer: { status: "up", failureCategory: null },
        emailProvider: { status: "disabled", failureCategory: null, lastSuccessAt: null }
      },
      workers: {
        issuance: { enabled: false, lastPollAt: null, queueDepth: 0, oldestPendingAgeSeconds: null },
        expiry: { enabled: false },
        emailDelivery: { enabled: false }
      }
    });

    for (const forbidden of [
      databaseUrl,
      "postgres://",
      "postgres:postgres",
      String(harness.proxy.port),
      harness.database.databaseName,
      harness.storageRoot,
      TEST_TOKENS.monitoring,
      "ECONNREFUSED",
      "stack",
      "    at "
    ]) {
      expect(response.text).not.toContain(forbidden);
    }

    const ready = await harness.get("/health/ready");
    expect(Object.keys(ready.body as object).sort()).toEqual(["checks", "status"]);
    expect(ready.text).not.toContain(harness.database.databaseName);
  }, TEST_TIMEOUT_MS);
});

describe("runtime reliability: graceful shutdown", () => {
  it("J: marks not-ready, stops probes and jobs before closing HTTP, closes the pool last", async () => {
    const harness = await startHarness();
    const { context } = harness;
    const order: string[] = [];
    const lifecycleAt: Record<string, boolean> = {};
    const record = (name: string) => {
      order.push(name);
      lifecycleAt[name] = context.lifecycleState.isShuttingDown;
    };
    const monitorStop = context.dependencyMonitor.stop.bind(context.dependencyMonitor);
    const jobsStop = context.backgroundJobs.stop.bind(context.backgroundJobs);
    const databaseClose = context.database.close.bind(context.database);
    vi.spyOn(context.dependencyMonitor, "stop").mockImplementation(async () => {
      record("monitor.stop");
      await monitorStop();
    });
    vi.spyOn(context.backgroundJobs, "stop").mockImplementation(async () => {
      record("jobs.stop");
      await jobsStop();
    });
    vi.spyOn(context.database, "close").mockImplementation(async () => {
      record("database.close");
      await databaseClose();
    });

    const outcome = await context.shutdown("SIGTERM");

    expect(outcome).toBe("completed");
    expect(order).toEqual(["monitor.stop", "jobs.stop", "database.close"]);
    expect(Object.values(lifecycleAt).every(Boolean)).toBe(true);
    expect(context.dependencyMonitor.readiness()).toMatchObject({ status: "not_ready", checks: { lifecycle: "fail" } });
    expect(context.dependencyMonitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "lifecycle" });
    await expect(context.database.query("select 1")).rejects.toThrow();
    await expect(fetch(`${harness.baseUrl}/health/live`)).rejects.toThrow();
    // Idempotent: a second signal joins the first shutdown.
    await expect(context.shutdown("SIGINT")).resolves.toBe("completed");
  }, TEST_TIMEOUT_MS);

  it("J: shutdown is bounded by APP_SHUTDOWN_TIMEOUT_MS when a request never finishes", async () => {
    let releaseRequest: () => void = () => undefined;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const harness = await startHarness({
      envOverrides: { APP_SHUTDOWN_TIMEOUT_MS: "1000" },
      hang: requestReleased
    });
    cleanups.push(() => {
      releaseRequest();
      return Promise.resolve();
    });

    const hangingRequest = harness.post("/probe/hang", {}).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const startedAt = Date.now();
    const outcome = await harness.context.shutdown("SIGTERM");
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toBe("timed_out");
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(3_000);

    releaseRequest();
    await hangingRequest;
  }, TEST_TIMEOUT_MS);
});
