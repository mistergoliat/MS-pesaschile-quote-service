import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPABILITIES, DependencyMonitor } from "../../src/application/health/dependency-monitor";
import {
  PROBE_OK,
  probeFailed,
  type DatabaseProbeResult,
  type SchemaHeadState
} from "../../src/application/health/dependency-state";

const DB_UP: DatabaseProbeResult = {
  connection: PROBE_OK,
  schema: { state: "READY", actualHead: "000005_head" }
};

const DB_DOWN: DatabaseProbeResult = {
  connection: probeFailed("unreachable"),
  schema: { state: "DB_UNAVAILABLE", actualHead: null }
};

function schemaResult(state: SchemaHeadState, actualHead: string | null): DatabaseProbeResult {
  return { connection: PROBE_OK, schema: { state, actualHead } };
}

function createHarness(config: Partial<{ retryMinMs: number; retryMaxMs: number; intervalMs: number; probeTimeoutMs: number }> = {}) {
  const state = {
    database: DB_UP as DatabaseProbeResult | Promise<DatabaseProbeResult>,
    artifactStorage: PROBE_OK,
    renderer: PROBE_OK,
    shuttingDown: false
  };
  const calls = { database: 0 };
  const logs: Array<{ level: "info" | "warn"; payload: Record<string, unknown> }> = [];
  const monitor = new DependencyMonitor(
    {
      database: {
        probe: () => {
          calls.database += 1;
          return Promise.resolve(state.database);
        }
      },
      artifactStorage: { probe: () => Promise.resolve(state.artifactStorage) },
      renderer: { probe: () => Promise.resolve(state.renderer) }
    },
    {
      get isShuttingDown() {
        return state.shuttingDown;
      }
    },
    {
      intervalMs: config.intervalMs ?? 10_000,
      retryMinMs: config.retryMinMs ?? 100,
      retryMaxMs: config.retryMaxMs ?? 400,
      probeTimeoutMs: config.probeTimeoutMs ?? 50,
      expectedSchemaHead: "000005_head",
      now: () => new Date("2026-10-05T12:00:00.000Z")
    },
    {
      info: (payload) => logs.push({ level: "info", payload }),
      warn: (payload) => logs.push({ level: "warn", payload })
    }
  );

  return { monitor, state, calls, logs, events: () => logs.map((entry) => entry.payload.event) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DependencyMonitor readiness", () => {
  it("is not ready before the first probe", () => {
    const { monitor } = createHarness();

    expect(monitor.readiness()).toEqual({
      status: "not_ready",
      checks: { database: "fail", schema: "fail", artifactStorage: "fail", renderer: "fail", lifecycle: "ok" }
    });
    expect(monitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "database" });
  });

  it("is ready when every dependency is usable", async () => {
    const { monitor } = createHarness();
    await monitor.probeNow();

    expect(monitor.readiness().status).toBe("ready");
    expect(monitor.businessGate()).toBeNull();
    expect(monitor.details()).toEqual({
      schema: { expectedHead: "000005_head", actualHead: "000005_head", state: "READY" },
      dependencies: {
        database: { status: "up", failureCategory: null, lastSuccessAt: "2026-10-05T12:00:00.000Z" },
        artifactStorage: { status: "up", failureCategory: null, lastSuccessAt: "2026-10-05T12:00:00.000Z" },
        renderer: { status: "up", failureCategory: null, lastSuccessAt: "2026-10-05T12:00:00.000Z" }
      }
    });
  });

  it("fails database and schema when the database is unreachable", async () => {
    const { monitor, state } = createHarness();
    state.database = DB_DOWN;
    await monitor.probeNow();

    expect(monitor.readiness().checks).toMatchObject({ database: "fail", schema: "fail" });
    expect(monitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "database" });
    expect(monitor.details().dependencies.database).toEqual({
      status: "down",
      failureCategory: "unreachable",
      lastSuccessAt: null
    });
  });

  it.each(["SCHEMA_MISSING", "SCHEMA_BEHIND", "SCHEMA_AHEAD_OR_UNKNOWN"] as const)(
    "gates business traffic with schema_not_ready when %s",
    async (schemaState) => {
      const { monitor, state } = createHarness();
      state.database = schemaResult(schemaState, schemaState === "SCHEMA_MISSING" ? null : "000004_x");
      await monitor.probeNow();

      expect(monitor.readiness().checks).toMatchObject({ database: "ok", schema: "fail" });
      expect(monitor.businessGate()).toEqual({ code: "schema_not_ready" });
      expect(monitor.details().dependencies.database).toMatchObject({
        status: "degraded",
        failureCategory: "schema_mismatch"
      });
    }
  );

  it("gates on storage and renderer failures", async () => {
    const { monitor, state } = createHarness();
    state.artifactStorage = probeFailed("storage_read_only");
    await monitor.probeNow();
    expect(monitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "artifactStorage" });
    expect(monitor.details().dependencies.artifactStorage.failureCategory).toBe("storage_read_only");

    state.artifactStorage = PROBE_OK;
    state.renderer = probeFailed("renderer_unavailable");
    await monitor.probeNow();
    expect(monitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "renderer" });
  });

  it("is not ready while shutting down regardless of dependencies", async () => {
    const { monitor, state } = createHarness();
    await monitor.probeNow();
    state.shuttingDown = true;

    expect(monitor.readiness()).toMatchObject({ status: "not_ready", checks: { lifecycle: "fail" } });
    expect(monitor.businessGate()).toEqual({ code: "dependency_unavailable", dependency: "lifecycle" });
  });

  it("bounds a hanging probe by the probe timeout", async () => {
    const { monitor, state } = createHarness({ probeTimeoutMs: 30 });
    state.database = new Promise(() => undefined);
    const startedAt = Date.now();
    await monitor.probeNow();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(monitor.details().dependencies.database).toMatchObject({ status: "down", failureCategory: "timeout" });
  });

  it("treats a rejected probe as a failed dependency", async () => {
    const { monitor } = createHarness();
    const failing = new DependencyMonitor(
      {
        database: { probe: () => Promise.reject(new Error("boom")) },
        artifactStorage: { probe: () => Promise.resolve(PROBE_OK) },
        renderer: { probe: () => Promise.reject(new Error("boom")) }
      },
      { isShuttingDown: false },
      { intervalMs: 1_000, retryMinMs: 100, retryMaxMs: 400, probeTimeoutMs: 50, expectedSchemaHead: "x" },
      { info: () => undefined, warn: () => undefined }
    );
    await failing.probeNow();

    expect(failing.readiness().checks).toMatchObject({ database: "fail", renderer: "fail", artifactStorage: "ok" });
    expect(monitor).toBeDefined();
  });

  it("runs a single probe cycle for concurrent callers", async () => {
    const { monitor, calls } = createHarness();
    await Promise.all([monitor.probeNow(), monitor.probeNow(), monitor.probeNow()]);
    monitor.requestProbe();

    expect(calls.database).toBe(1);
  });
});

describe("DependencyMonitor persistence readiness (issuance deadline sweep)", () => {
  it("AK/AL: stays persistence-ready while storage or the renderer is down", async () => {
    const { monitor, state } = createHarness();
    state.artifactStorage = probeFailed("storage_read_only");
    state.renderer = probeFailed("renderer_unavailable");
    await monitor.probeNow();

    expect(monitor.isReady()).toBe(false);
    expect(monitor.isPersistenceReady()).toBe(true);
  });

  it("AM: is not persistence-ready without the database, at a wrong schema head, before the first probe or while shutting down", async () => {
    const { monitor, state } = createHarness();
    expect(monitor.isPersistenceReady()).toBe(false);

    state.database = DB_DOWN;
    await monitor.probeNow();
    expect(monitor.isPersistenceReady()).toBe(false);

    state.database = schemaResult("SCHEMA_BEHIND", "000004_x");
    await monitor.probeNow();
    expect(monitor.isPersistenceReady()).toBe(false);

    state.database = schemaResult("SCHEMA_INTEGRITY_MISMATCH", "000005_head");
    await monitor.probeNow();
    expect(monitor.isPersistenceReady()).toBe(false);

    state.database = DB_UP;
    await monitor.probeNow();
    expect(monitor.isPersistenceReady()).toBe(true);

    state.shuttingDown = true;
    expect(monitor.isPersistenceReady()).toBe(false);
    // The public readiness semantics are unchanged.
    expect(monitor.readiness().checks.lifecycle).toBe("fail");
  });
});

describe("DependencyMonitor transition logging (K)", () => {
  it("logs one down event for a long outage and one recovery event", async () => {
    const { monitor, state, logs, events } = createHarness();
    await monitor.probeNow();
    expect(events()).toEqual(["runtime.ready"]);

    state.database = DB_DOWN;

    for (let cycle = 0; cycle < 20; cycle += 1) {
      await monitor.probeNow();
    }

    expect(events()).toEqual(["runtime.ready", "dependency.down", "runtime.unready"]);
    expect(logs[1]).toEqual({
      level: "warn",
      payload: { event: "dependency.down", dependency: "database", failureCategory: "unreachable" }
    });
    expect(logs[2]?.payload).toEqual({ event: "runtime.unready", failing: ["database", "schema"] });

    state.database = DB_UP;
    await monitor.probeNow();
    await monitor.probeNow();

    expect(events()).toEqual([
      "runtime.ready",
      "dependency.down",
      "runtime.unready",
      "dependency.recovered",
      "runtime.ready"
    ]);
  });

  it("logs a new down event only when the failure category changes", async () => {
    const { monitor, state, events } = createHarness();
    state.database = DB_DOWN;
    await monitor.probeNow();
    await monitor.probeNow();
    state.database = { ...DB_DOWN, connection: probeFailed("authentication") };
    await monitor.probeNow();
    await monitor.probeNow();

    expect(events()).toEqual(["dependency.down", "runtime.unready", "dependency.down"]);
  });

  it("logs schema.not_ready once per distinct schema state", async () => {
    const { monitor, state, logs, events } = createHarness();
    state.database = schemaResult("SCHEMA_BEHIND", "000004_x");
    await monitor.probeNow();
    await monitor.probeNow();
    await monitor.probeNow();

    expect(events()).toEqual(["schema.not_ready", "runtime.unready"]);
    expect(logs[0]?.payload).toEqual({
      event: "schema.not_ready",
      state: "SCHEMA_BEHIND",
      expectedHead: "000005_head",
      actualHead: "000004_x"
    });

    state.database = DB_UP;
    await monitor.probeNow();
    expect(events()).toEqual(["schema.not_ready", "runtime.unready", "dependency.recovered", "runtime.ready"]);
  });

  it("never logs connection strings or raw errors", async () => {
    const { monitor, state, logs } = createHarness();
    state.database = DB_DOWN;
    await monitor.probeNow();

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/postgres:\/\/|password|stack/i);
  });
});

describe("DependencyMonitor cadence", () => {
  it("backs off between failed cycles up to the cap and returns to the steady interval on recovery", async () => {
    vi.useFakeTimers();
    const { monitor, state, calls } = createHarness({ retryMinMs: 100, retryMaxMs: 400, intervalMs: 5_000 });
    state.database = DB_DOWN;
    await monitor.probeNow();
    expect(calls.database).toBe(1);
    monitor.start();

    await vi.advanceTimersByTimeAsync(100); // retry 1 after 100ms
    expect(calls.database).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(calls.database).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // retry 2 after 200ms
    expect(calls.database).toBe(3);
    await vi.advanceTimersByTimeAsync(400); // retry 3 after 400ms (cap)
    expect(calls.database).toBe(4);
    await vi.advanceTimersByTimeAsync(400); // still capped
    expect(calls.database).toBe(5);

    state.database = DB_UP;
    await vi.advanceTimersByTimeAsync(400); // recovery observed
    expect(calls.database).toBe(6);
    expect(monitor.isReady()).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls.database).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.database).toBe(7);

    await monitor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.database).toBe(7);
  });
});

describe("DependencyMonitor capability gates (R1.6D)", () => {
  const storage = { code: "dependency_unavailable", dependency: "artifactStorage" };
  const renderer = { code: "dependency_unavailable", dependency: "renderer" };
  const database = { code: "dependency_unavailable", dependency: "database" };
  const lifecycle = { code: "dependency_unavailable", dependency: "lifecycle" };

  it.each([
    ["all healthy", {}, { PERSISTENCE: null, DOCUMENT_READ: null, ISSUANCE: null, DELIVERY_REQUEST: null, DELIVERY_SEND: null, DEADLINE_SWEEP: null }],
    ["renderer down", { renderer: true }, { PERSISTENCE: null, DOCUMENT_READ: null, ISSUANCE: renderer, DELIVERY_REQUEST: null, DELIVERY_SEND: null, DEADLINE_SWEEP: null }],
    ["storage down", { storage: true }, { PERSISTENCE: null, DOCUMENT_READ: storage, ISSUANCE: storage, DELIVERY_REQUEST: null, DELIVERY_SEND: storage, DEADLINE_SWEEP: null }],
    ["storage and renderer down", { storage: true, renderer: true }, { PERSISTENCE: null, DOCUMENT_READ: storage, ISSUANCE: storage, DELIVERY_REQUEST: null, DELIVERY_SEND: storage, DEADLINE_SWEEP: null }],
    ["database down", { database: true }, { PERSISTENCE: database, DOCUMENT_READ: database, ISSUANCE: database, DELIVERY_REQUEST: database, DELIVERY_SEND: database, DEADLINE_SWEEP: database }],
    ["schema behind", { schema: true }, Object.fromEntries(CAPABILITIES.map((capability) => [capability, { code: "schema_not_ready" }]))],
    ["shutting down", { shutdown: true }, Object.fromEntries(CAPABILITIES.map((capability) => [capability, lifecycle]))]
  ] as const)("%s", async (_label, faults: Partial<Record<"renderer" | "storage" | "database" | "schema" | "shutdown", boolean>>, expected) => {
    const { monitor, state } = createHarness();
    state.renderer = faults.renderer ? probeFailed("renderer_unavailable") : PROBE_OK;
    state.artifactStorage = faults.storage ? probeFailed("unreachable") : PROBE_OK;
    state.database = faults.database ? DB_DOWN : faults.schema ? schemaResult("SCHEMA_BEHIND", "000004_x") : DB_UP;
    await monitor.probeNow();
    state.shuttingDown = faults.shutdown ?? false;

    expect(Object.fromEntries(CAPABILITIES.map((capability) => [capability, monitor.gate(capability)]))).toEqual(expected);
    // The compatibility alias is exactly the full issuance gate, and readiness is unchanged by capabilities.
    expect(monitor.businessGate()).toEqual(monitor.gate("ISSUANCE"));
    expect(monitor.isReady()).toBe(monitor.gate("ISSUANCE") === null);
  });
});
