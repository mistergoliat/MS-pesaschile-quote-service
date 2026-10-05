import { spawn, type ChildProcess } from "node:child_process";
import fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { ToggleableTcpProxy } from "../helpers/toggleable-tcp-proxy";

const TEST_TIMEOUT_MS = 90_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface ServerProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

function startServer(env: Record<string, string>): ServerProcess {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  cleanups.push(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });

  return { child, output: () => output, exited };
}

function events(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { event?: unknown };
        return typeof parsed.event === "string" ? [parsed.event] : [];
      } catch {
        return [];
      }
    });
}

async function status(url: string): Promise<number | null> {
  try {
    return (await fetch(url)).status;
  } catch {
    return null;
  }
}

describe("server process lifecycle", () => {
  it("exits 1 on invalid static configuration without echoing values", async () => {
    const server = startServer({
      DATABASE_URL: "not-a-url-secret-sauce",
      SERVICE_AUTH_TOKEN: "",
      QUOTE_DOCUMENT_STORAGE_ROOT: "",
      QUOTE_DOCUMENT_REF_SECRET: ""
    });

    expect(await server.exited).toBe(1);
    expect(events(server.output())).toContain("runtime.config_invalid");
    expect(server.output()).not.toContain("secret-sauce");
  }, TEST_TIMEOUT_MS);

  it("stays alive through a database outage at startup and becomes ready without restart", async () => {
    const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => database.dispose());
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-process-"));
    cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
    const target = new URL(database.connectionString);
    const proxy = await ToggleableTcpProxy.create(target.hostname, Number(target.port || 5432));
    cleanups.push(() => proxy.dispose());
    await proxy.disable();
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const server = startServer({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: "info",
      DATABASE_URL: proxy.route(database.connectionString),
      DB_POOL_CONNECTION_TIMEOUT_MS: "1000",
      SERVICE_AUTH_TOKEN: "token",
      HEALTH_PROBE_TIMEOUT_MS: "1000",
      HEALTH_PROBE_INTERVAL_MS: "1000",
      HEALTH_PROBE_RETRY_MIN_MS: "100",
      HEALTH_PROBE_RETRY_MAX_MS: "200",
      QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
      QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
      QUOTE_EMAIL_PROVIDER: "disabled"
    });

    await waitFor(async () => (await status(`${baseUrl}/health/live`)) === 200, 45_000, 200);
    expect(await status(`${baseUrl}/health/ready`)).toBe(503);

    // ~10 failed probe cycles at 100–200ms backoff.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(server.child.exitCode).toBeNull();
    expect(await status(`${baseUrl}/health/live`)).toBe(200);
    expect(await status(`${baseUrl}/health/ready`)).toBe(503);

    await proxy.enable();
    await waitFor(async () => (await status(`${baseUrl}/health/ready`)) === 200, 15_000, 100);

    const observed = events(server.output());
    expect(observed).toContain("runtime.started");
    expect(observed.filter((event) => event === "dependency.down")).toHaveLength(1);
    expect(observed.filter((event) => event === "runtime.unready")).toHaveLength(1);
    expect(observed).toContain("dependency.recovered");
    expect(observed).toContain("runtime.ready");
    expect(server.output()).not.toContain(database.databaseName);
    expect(server.output()).not.toContain("postgres://");

    if (process.platform !== "win32") {
      server.child.kill("SIGTERM");
      expect(await server.exited).toBe(0);
      expect(events(server.output())).toEqual(
        expect.arrayContaining(["shutdown.started", "shutdown.completed"])
      );
    }
  }, TEST_TIMEOUT_MS);
});
