import { spawn, type ChildProcess } from "node:child_process";

import { testRegistryJson } from "./test-principals";

/*
 * Real service processes for the R1.5B4 crash harness: each one is
 * `node --import tsx test/process/failpoint-server.ts`, a separate OS process
 * with its own pool, timers and lease owner. `kill()` is SIGKILL (on Windows
 * TerminateProcess): no finally block, shutdown hook or failure write runs.
 */

export interface ServiceProcessOptions {
  readonly databaseUrl: string;
  readonly storageRoot: string;
  readonly syncBudgetMs: number;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly halt?: string;
  readonly suspendRenewals?: boolean;
  /** R1.6B: delivery checkpoint to hold at. */
  readonly deliveryHalt?: string;
  /** R1.6B: loopback base URL of a fake mail provider running in the parent test process. */
  readonly fakeMailProvider?: string;
  /** R1.6B: delivery lease and poll interval. */
  readonly deliveryLeaseMs?: number;
  readonly deliveryPollIntervalMs?: number;
  /** Principal registry JSON (default: the shared test registry). */
  readonly registryJson?: string;
}

export interface LogLine extends Record<string, unknown> {
  readonly event?: string;
}

export interface ServiceProcess {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly pid: number;
  lines(): LogLine[];
  events(name: string): LogLine[];
  waitFor(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
  /** Abrupt termination (SIGKILL); resolves once the OS reports the exit. */
  kill(): Promise<void>;
  /** Graceful stop (SIGTERM → bounded shutdown). */
  stop(): Promise<number | null>;
  resume(): void;
  readonly exited: Promise<number | null>;
}

export function serviceEnv(options: ServiceProcessOptions): Record<string, string> {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "info",
    DATABASE_URL: options.databaseUrl,
    DATABASE_SSL_MODE: "disable",
    DB_POOL_CONNECTION_TIMEOUT_MS: "1000",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-crash",
    QUOTE_PRINCIPAL_REGISTRY_JSON: options.registryJson ?? testRegistryJson(),
    HEALTH_PROBE_TIMEOUT_MS: "1000",
    HEALTH_PROBE_INTERVAL_MS: "1000",
    HEALTH_PROBE_RETRY_MIN_MS: "100",
    HEALTH_PROBE_RETRY_MAX_MS: "400",
    QUOTE_DOCUMENT_STORAGE_ROOT: options.storageRoot,
    QUOTE_ISSUANCE_DEADLINE_MS: "3600000",
    QUOTE_ISSUANCE_LEASE_MS: String(options.leaseMs ?? 10_000),
    QUOTE_ISSUANCE_POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 500),
    QUOTE_ISSUANCE_SYNC_BUDGET_MS: String(options.syncBudgetMs),
    QUOTE_EMAIL_DELIVERY_LEASE_MS: String(options.deliveryLeaseMs ?? 15_000),
    QUOTE_EMAIL_POLL_INTERVAL_MS: String(options.deliveryPollIntervalMs ?? 300),
    QUOTE_EMAIL_TOKEN_TIMEOUT_MS: "1000",
    QUOTE_EMAIL_SEND_TIMEOUT_MS: "2000"
  };
}

export async function startServiceProcess(options: ServiceProcessOptions, register: (cleanup: () => Promise<void>) => void): Promise<ServiceProcess> {
  const args = ["--import", "tsx", "test/process/failpoint-server.ts"];

  if (options.halt) {
    args.push(`--halt=${options.halt}`);
  }

  if (options.suspendRenewals) {
    args.push("--suspend-renewals");
  }

  if (options.deliveryHalt) {
    args.push(`--delivery-halt=${options.deliveryHalt}`);
  }

  if (options.fakeMailProvider) {
    args.push(`--fake-mail-provider=${options.fakeMailProvider}`);
  }

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...serviceEnv(options) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const parsed: LogLine[] = [];
  let raw = "";
  const waiters = new Set<() => void>();
  const onText = (chunk: Buffer) => {
    raw += chunk.toString("utf8");
    let newline = raw.indexOf("\n");

    while (newline >= 0) {
      const line = raw.slice(0, newline).trim();
      raw = raw.slice(newline + 1);
      newline = raw.indexOf("\n");

      if (line.startsWith("{")) {
        try {
          parsed.push(JSON.parse(line) as LogLine);
        } catch {
          // not a log line
        }
      }
    }

    for (const wake of waiters) {
      wake();
    }
  };
  child.stdout.on("data", onText);
  child.stderr.on("data", onText);
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    await exited;
  };
  register(kill);

  const waitFor = (predicate: (line: LogLine) => boolean, timeoutMs = 30_000): Promise<LogLine> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = parsed.find(predicate);

        if (found) {
          cleanup();
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for a log line; last events: ${parsed.slice(-8).map((line) => line.event ?? "?").join(", ")}`));
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        reject(new Error(`process exited before the expected log line; events: ${parsed.map((line) => line.event ?? "?").join(", ")}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(check);
        child.off("exit", onExit);
      };
      waiters.add(check);
      child.once("exit", onExit);
      check();
    });

  const listening = await waitFor((line) => line.event === "failpoint_server.listening", 60_000);

  return {
    child,
    baseUrl: String(listening.url),
    pid: child.pid!,
    lines: () => [...parsed],
    events: (name) => parsed.filter((line) => line.event === name),
    waitFor,
    kill,
    async stop() {
      child.kill("SIGTERM");
      return exited;
    },
    resume() {
      child.stdin.write("resume\n");
    },
    exited
  };
}
