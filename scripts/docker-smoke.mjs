import crypto from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const configuredBuildTimeoutMs = Number.parseInt(process.env.SMOKE_BUILD_TIMEOUT_MS ?? "", 10);
const BUILD_TIMEOUT_MS = Number.isFinite(configuredBuildTimeoutMs) ? configuredBuildTimeoutMs : 2_700_000;
// R1.4: the V1 API was retired with its persistence model and the V2 API
// arrives in R1.5, so this smoke covers the runtime that exists: image build,
// explicit migration to the V2 head, schema check, liveness/readiness/
// dependency health, V1 routes gone, restart with persisted state, graceful
// shutdown.
const PHASE_TIMEOUT_MS = {
  build: BUILD_TIMEOUT_MS,
  cleanup: 180_000,
  network: 30_000,
  postgresStart: 60_000,
  postgresReady: 60_000,
  migrations: 120_000,
  schemaCheck: 60_000,
  appStart: 60_000,
  liveness: 15_000,
  readiness: 60_000,
  dependencies: 15_000,
  v1Retired: 15_000,
  restart: 90_000,
  gracefulShutdown: 30_000
};

const phaseDefinitions = [
  { key: "cleanup", label: "PHASE 01 cleanup" },
  { key: "network", label: "PHASE 02 network" },
  { key: "postgresStart", label: "PHASE 03 postgres start" },
  { key: "postgresReady", label: "PHASE 04 postgres ready" },
  { key: "migrations", label: "PHASE 05 migrations" },
  { key: "schemaCheck", label: "PHASE 06 schema check" },
  { key: "appStart", label: "PHASE 07 app start" },
  { key: "liveness", label: "PHASE 08 liveness" },
  { key: "readiness", label: "PHASE 09 readiness" },
  { key: "dependencies", label: "PHASE 10 dependencies" },
  { key: "v1Retired", label: "PHASE 11 v1 retired" },
  { key: "restart", label: "PHASE 12 restart" },
  { key: "gracefulShutdown", label: "PHASE 13 graceful shutdown" }
];

const imageTag = process.env.SMOKE_IMAGE_TAG ?? "pesaschile-quote-service:t06-smoke";
const postgresImage = process.env.SMOKE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const skipBuild = process.env.SMOKE_SKIP_BUILD === "1";
const keepResources = process.env.SMOKE_KEEP_RESOURCES === "1";
const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

const state = {
  names: {
    network: `quote-smoke-net-${suffix}`,
    volume: `quote-documents-smoke-${suffix}`,
    postgres: `quote-smoke-db-${suffix}`,
    appPrimary: `quote-smoke-app-a-${suffix}`,
    appRestarted: `quote-smoke-app-b-${suffix}`
  },
  paths: {
    storageRoot: "/var/lib/pesaschile/quote-documents"
  },
  credentials: {
    // Monitoring principal for /health/dependencies (registry stores only the hash).
    serviceAuthToken: crypto.randomBytes(32).toString("base64url")
  },
  app: {
    hostPort: null,
    baseUrl: null,
    activeContainer: null
  },
  containersStarted: new Set(),
  logs: {
    primaryApp: "",
    restartedApp: ""
  },
  summary: {
    imageTag,
    imageId: null,
    phases: [],
    appliedMigrations: [],
    schemaHead: null,
    gracefulShutdownExitCode: null
  }
};

function log(message) {
  console.log(`[docker-smoke] ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toDockerEnvArgs(envObject) {
  return Object.entries(envObject).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function buildAppEnv() {
  return {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3000",
    LOG_LEVEL: "info",
    DATABASE_URL: `postgres://postgres:postgres@${state.names.postgres}:5432/quote_smoke`,
    DATABASE_SSL_MODE: "disable",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-smoke",
    QUOTE_PRINCIPAL_REGISTRY_JSON: JSON.stringify({
      version: 1,
      principals: [
        {
          principalId: "monitoring",
          principalType: "service",
          scopes: ["service:health:dependencies"],
          tokenSha256: [crypto.createHash("sha256").update(state.credentials.serviceAuthToken).digest("hex")]
        }
      ]
    }),
    QUOTE_DOCUMENT_STORAGE_ROOT: state.paths.storageRoot,
    QUOTE_RENDER_VERSION: "quote-pdf-v3"
  };
}

function formatDuration(ms) {
  return `${ms}ms`;
}

function getPhaseLabel(key) {
  const phase = phaseDefinitions.find((entry) => entry.key === key);
  return phase ? phase.label : key;
}

async function terminateProcessTree(pid) {
  if (typeof pid !== "number" || Number.isNaN(pid)) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });

      killer.on("error", () => resolve(undefined));
      killer.on("close", () => resolve(undefined));
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore kill failures during cleanup.
  }
}

function destroyStream(stream) {
  if (!stream || typeof stream.destroy !== "function" || stream.destroyed) {
    return;
  }

  stream.destroy();
}

async function runCommand(command, args, options = {}) {
  const {
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    cwd = process.cwd(),
    env = process.env,
    stdin = null,
    allowFailure = false
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceSettleTimer = null;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      void terminateProcessTree(child.pid)
        .catch(() => undefined)
        .finally(() => {
          destroyStream(child.stdin);
          destroyStream(child.stdout);
          destroyStream(child.stderr);

          forceSettleTimer = setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            reject(
              new Error(
                [
                  `Command timed out: ${command} ${args.join(" ")}`,
                  `timeout=${timeoutMs}ms`,
                  stdout.trim(),
                  stderr.trim()
                ]
                  .filter((part) => part.length > 0)
                  .join("\n")
              )
            );
          }, 5_000);
          forceSettleTimer.unref();
        });
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (forceSettleTimer !== null) {
        clearTimeout(forceSettleTimer);
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (forceSettleTimer !== null) {
        clearTimeout(forceSettleTimer);
      }

      if (timedOut && !allowFailure) {
        reject(
          new Error(
            [
              `Command timed out: ${command} ${args.join(" ")}`,
              `timeout=${timeoutMs}ms`,
              code === null ? `signal=${signal}` : `exitCode=${code}`,
              stdout.trim(),
              stderr.trim()
            ]
              .filter((part) => part.length > 0)
              .join("\n")
          )
        );
        return;
      }

      if (timedOut) {
        resolve({
          code: code ?? 1,
          signal,
          stdout,
          stderr,
          timedOut: true
        });
        return;
      }

      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            [
              `Command failed: ${command} ${args.join(" ")}`,
              `timeout=${timeoutMs}ms`,
              code === null ? `signal=${signal}` : `exitCode=${code}`,
              stdout.trim(),
              stderr.trim()
            ]
              .filter((part) => part.length > 0)
              .join("\n")
          )
        );
        return;
      }

      resolve({
        code: code ?? 0,
        signal,
        stdout,
        stderr
      });
    });

    if (stdin !== null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function docker(args, options = {}) {
  return runCommand("docker", args, options);
}

async function fetchJson(path, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  } = options;
  const controller = new AbortController();
  // Ref'd on purpose: a connection that stalls without holding the event
  // loop (e.g. Docker's port proxy before the app binds) must be aborted and
  // retried, not let the process exit silently.
  const timer = setTimeout(() => {
    controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(`${state.app.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) : null;

    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForContainerHealth(containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const inspect = await docker(
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        containerName
      ],
      {
        allowFailure: true,
        timeoutMs: 10_000
      }
    );
    lastStatus = inspect.stdout.trim();

    if (lastStatus === "healthy" || lastStatus === "running") {
      return lastStatus;
    }

    if (lastStatus === "unhealthy" || lastStatus === "exited" || lastStatus === "dead") {
      throw new Error(`Container ${containerName} became ${lastStatus}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Container ${containerName} did not become ready within ${timeoutMs}ms; lastStatus=${lastStatus}`);
}

async function waitForReadiness(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "none";
  let lastStatus = "none";

  while (Date.now() < deadline) {
    try {
      const response = await fetchJson("/health/ready", {
        timeoutMs: 5_000
      });
      lastStatus = String(response.status);

      if (response.status === 200) {
        assert(response.body?.status === "ready", "Readiness body did not report ready");
        return response.body;
      }

      lastError = response.text;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Readiness did not become green within ${timeoutMs}ms; lastStatus=${lastStatus}; lastError=${lastError}`);
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "none";
  let lastStatus = "none";

  while (Date.now() < deadline) {
    try {
      const response = await fetchJson("/health/live", {
        timeoutMs: 5_000
      });
      lastStatus = String(response.status);

      if (response.status === 200) {
        assert(response.body?.status === "live", "Liveness body did not report live");
        return response.body;
      }

      lastError = response.text;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Health did not become green within ${timeoutMs}ms; lastStatus=${lastStatus}; lastError=${lastError}`);
}

async function getPublishedPort(containerName) {
  const inspect = await docker(
    [
      "inspect",
      "--format",
      "{{with index .NetworkSettings.Ports \"3000/tcp\"}}{{(index . 0).HostPort}}{{end}}",
      containerName
    ],
    {
      timeoutMs: 10_000
    }
  );
  const hostPort = inspect.stdout.trim();

  assert(hostPort.length > 0, `Could not determine host port for ${containerName}`);
  return Number(hostPort);
}

async function readLogs(containerName) {
  const result = await docker(["logs", containerName], {
    allowFailure: true,
    timeoutMs: 20_000
  });

  return `${result.stdout}${result.stderr}`;
}

async function inspectContainer(containerName) {
  const result = await docker(
    ["inspect", "--format", "{{.State.Status}}/{{.State.ExitCode}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}", containerName],
    {
      allowFailure: true,
      timeoutMs: 10_000
    }
  );

  return result.stdout.trim();
}

async function dockerPs() {
  const result = await docker(
    ["ps", "-a", "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}"],
    {
      allowFailure: true,
      timeoutMs: 10_000
    }
  );

  return result.stdout.trim();
}

async function queryDatabase(sql) {
  const result = await docker(
    [
      "exec",
      state.names.postgres,
      "psql",
      "-U",
      "postgres",
      "-d",
      "quote_smoke",
      "-At",
      "-c",
      sql
    ],
    {
      timeoutMs: 20_000
    }
  );

  return result.stdout.trim();
}

async function listDockerNames(args, prefix) {
  const result = await docker(args, {
    allowFailure: true,
    timeoutMs: 20_000
  });

  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix));
}

function extractSmokeSuffix(containerName) {
  const match = /^quote-smoke-(?:db|app-a|app-b)-(.+)$/.exec(containerName);
  return match?.[1] ?? null;
}

async function cleanupResources() {
  const containerNames = await listDockerNames(["ps", "-a", "--format", "{{.Names}}"], "quote-smoke-");
  const resourceSuffixes = new Set(
    [extractSmokeSuffix(state.names.postgres), ...containerNames.map((containerName) => extractSmokeSuffix(containerName))]
      .filter((value) => typeof value === "string" && value.length > 0)
  );

  log(`cleanup targets containers=${containerNames.length} suffixes=${resourceSuffixes.size}`);

  for (const containerName of containerNames) {
    await docker(["rm", "-f", containerName], {
      allowFailure: true,
      timeoutMs: 20_000
    }).catch(() => undefined);
  }

  for (const suffixValue of resourceSuffixes) {
    const networkName = `quote-smoke-net-${suffixValue}`;
    await docker(["network", "rm", networkName], {
      allowFailure: true,
      timeoutMs: 20_000
    }).catch(() => undefined);
  }

  for (const suffixValue of resourceSuffixes) {
    const volumeName = `quote-documents-smoke-${suffixValue}`;
    await docker(["volume", "rm", "-f", volumeName], {
      allowFailure: true,
      timeoutMs: 20_000
    }).catch(() => undefined);
  }
}

async function printDiagnostics(phaseLabel, error) {
  log(`${phaseLabel} diagnostics begin`);
  console.log(`[docker-smoke] ${phaseLabel} error=${error instanceof Error ? error.message : String(error)}`);
  console.log(`[docker-smoke] docker ps\n${await dockerPs()}`);

  for (const containerName of [state.names.appPrimary, state.names.appRestarted, state.names.postgres]) {
    if (!state.containersStarted.has(containerName)) {
      continue;
    }

    console.log(`[docker-smoke] inspect ${containerName}\n${await inspectContainer(containerName)}`);
    console.log(`[docker-smoke] logs ${containerName}\n${await readLogs(containerName)}`);
  }
}

async function runPhase(key, timeoutMs, work) {
  const label = getPhaseLabel(key);

  const startedAt = Date.now();
  log(`${label} START timeout=${timeoutMs}ms startedAt=${nowIso()}`);

  let phaseTimer;

  try {
    // Ref'd: a phase can never end the process silently; it either finishes or fails.
    const result = await Promise.race([
      work(),
      new Promise((_, reject) => {
        phaseTimer = setTimeout(() => {
          reject(new Error(`${label} exceeded phase timeout ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]).finally(() => clearTimeout(phaseTimer));
    const durationMs = Date.now() - startedAt;
    state.summary.phases.push({
      phase: label,
      status: "ok",
      timeoutMs,
      durationMs
    });
    log(`${label} OK duration=${formatDuration(durationMs)} result=success`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    state.summary.phases.push({
      phase: label,
      status: "failed",
      timeoutMs,
      durationMs,
      error: error instanceof Error ? error.message : String(error)
    });
    log(`${label} FAIL duration=${formatDuration(durationMs)} result=${error instanceof Error ? error.message : String(error)}`);
    await printDiagnostics(label, error);
    throw error;
  }
}

async function startApp(containerName, timeoutMs) {
  await docker(
    [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      state.names.network,
      "-p",
      "127.0.0.1::3000",
      "-v",
      `${state.names.volume}:${state.paths.storageRoot}`,
      ...toDockerEnvArgs(buildAppEnv()),
      imageTag
    ],
    {
      timeoutMs
    }
  );
  state.containersStarted.add(containerName);
  state.app.activeContainer = containerName;
  state.app.hostPort = await getPublishedPort(containerName);
  state.app.baseUrl = `http://127.0.0.1:${state.app.hostPort}`;
}

async function stopActiveApp() {
  if (!state.app.activeContainer) {
    return;
  }

  await docker(["stop", "--time", "10", state.app.activeContainer], {
    timeoutMs: 30_000
  });
}

async function runSmoke() {
  const authHeader = `Bearer ${state.credentials.serviceAuthToken}`;

  await runPhase("cleanup", PHASE_TIMEOUT_MS.cleanup, async () => {
    await cleanupResources();
  });

  if (!skipBuild) {
    log(`docker build target=${imageTag}`);
    await docker(["build", "--no-cache", "-t", imageTag, "."], {
      timeoutMs: PHASE_TIMEOUT_MS.build
    });
  }
  state.summary.imageId = (
    await docker(["image", "inspect", imageTag, "--format", "{{.Id}}"], {
      timeoutMs: 15_000
    })
  ).stdout.trim();

  await runPhase("network", PHASE_TIMEOUT_MS.network, async () => {
    await docker(["network", "create", state.names.network], {
      timeoutMs: PHASE_TIMEOUT_MS.network
    });
    await docker(["volume", "create", state.names.volume], {
      timeoutMs: PHASE_TIMEOUT_MS.network
    });
  });

  await runPhase("postgresStart", PHASE_TIMEOUT_MS.postgresStart, async () => {
    await docker(
      [
        "run",
        "-d",
        "--name",
        state.names.postgres,
        "--network",
        state.names.network,
        "--health-cmd",
        "pg_isready -U postgres -d quote_smoke",
        "--health-interval",
        "1s",
        "--health-timeout",
        "5s",
        "--health-retries",
        "30",
        "-e",
        "POSTGRES_DB=quote_smoke",
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_PASSWORD=postgres",
        postgresImage
      ],
      {
        timeoutMs: PHASE_TIMEOUT_MS.postgresStart
      }
    );
    state.containersStarted.add(state.names.postgres);
  });

  await runPhase("postgresReady", PHASE_TIMEOUT_MS.postgresReady, async () => {
    await waitForContainerHealth(state.names.postgres, PHASE_TIMEOUT_MS.postgresReady);
  });

  await runPhase("migrations", PHASE_TIMEOUT_MS.migrations, async () => {
    await docker(
      ["run", "--rm", "--network", state.names.network, ...toDockerEnvArgs(buildAppEnv()), imageTag, "npm", "run", "db:migrate:runtime"],
      { timeoutMs: PHASE_TIMEOUT_MS.migrations }
    );

    const appliedMigrations = (await queryDatabase("select name from public.schema_migrations order by id;"))
      .split(/\r?\n/)
      .filter((value) => value.length > 0);
    state.summary.appliedMigrations = appliedMigrations;
    assert(
      appliedMigrations.at(-1) === "000008_quote_v2_runtime_grants",
      `Unexpected migration head: ${appliedMigrations.join(", ")}`
    );
    const checksums = (await queryDatabase("select count(*) from quote_service.schema_migration_checksums;")).trim();
    assert(checksums === String(appliedMigrations.length), `Expected a checksum per migration, got ${checksums}`);
  });

  await runPhase("schemaCheck", PHASE_TIMEOUT_MS.schemaCheck, async () => {
    const result = await docker(
      ["run", "--rm", "--network", state.names.network, ...toDockerEnvArgs(buildAppEnv()), imageTag, "npm", "run", "--silent", "db:check:runtime"],
      { timeoutMs: PHASE_TIMEOUT_MS.schemaCheck }
    );
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    state.summary.schemaHead = report.schema;
    assert(report.status === "ok" && report.schema.state === "READY", `db:check not ready: ${result.stdout}`);
  });

  await runPhase("appStart", PHASE_TIMEOUT_MS.appStart, async () => {
    await startApp(state.names.appPrimary, PHASE_TIMEOUT_MS.appStart);
  });

  await runPhase("liveness", PHASE_TIMEOUT_MS.liveness, async () => {
    await waitForHealth(PHASE_TIMEOUT_MS.liveness);
  });

  await runPhase("readiness", PHASE_TIMEOUT_MS.readiness, async () => {
    const body = await waitForReadiness(PHASE_TIMEOUT_MS.readiness);
    assert(
      JSON.stringify(body.checks) ===
        JSON.stringify({ database: "ok", schema: "ok", artifactStorage: "ok", renderer: "ok", lifecycle: "ok" }),
      `Unexpected readiness checks: ${JSON.stringify(body.checks)}`
    );
  });

  await runPhase("dependencies", PHASE_TIMEOUT_MS.dependencies, async () => {
    const unauthorized = await fetchJson("/health/dependencies", { timeoutMs: 5_000 });
    assert(unauthorized.status === 401, `Expected 401 without credentials, got ${unauthorized.status}`);
    const details = await fetchJson("/health/dependencies", { headers: { Authorization: authHeader }, timeoutMs: 5_000 });
    assert(details.status === 200, `Expected 200, got ${details.status}`);
    assert(
      details.body.schema.expectedHead === "000008_quote_v2_runtime_grants" &&
        details.body.schema.actualHead === details.body.schema.expectedHead,
      `Unexpected schema head: ${JSON.stringify(details.body.schema)}`
    );
    assert(!details.text.includes("postgres://"), "Dependency details leaked a DSN");
    assert(!details.text.includes(state.credentials.serviceAuthToken), "Dependency details leaked the credential");
  });

  await runPhase("v1Retired", PHASE_TIMEOUT_MS.v1Retired, async () => {
    const response = await fetchJson("/v1/quotes", { headers: { Authorization: authHeader }, timeoutMs: 5_000 });
    assert(response.status === 404, `Expected retired V1 route to be absent (404), got ${response.status}`);
  });

  await runPhase("restart", PHASE_TIMEOUT_MS.restart, async () => {
    await stopActiveApp();
    state.logs.primaryApp = await readLogs(state.names.appPrimary);
    await startApp(state.names.appRestarted, PHASE_TIMEOUT_MS.restart);
    await waitForReadiness(60_000);
  });

  await runPhase("gracefulShutdown", PHASE_TIMEOUT_MS.gracefulShutdown, async () => {
    await stopActiveApp();
    state.logs.restartedApp = await readLogs(state.names.appRestarted);
    state.summary.gracefulShutdownExitCode = Number(
      (await docker(["inspect", "--format", "{{.State.ExitCode}}", state.names.appRestarted], { timeoutMs: 10_000 })).stdout.trim()
    );

    assert(state.summary.gracefulShutdownExitCode === 0, "Application exit code was not zero");
    const combinedLogs = `${state.logs.primaryApp}
${state.logs.restartedApp}`;
    assert(combinedLogs.includes('"event":"shutdown.started"'), "Missing shutdown.started event");
    assert(combinedLogs.includes('"event":"shutdown.completed"'), "Missing shutdown.completed event");
    assert(!combinedLogs.includes("postgres:postgres"), "Logs leaked database credentials");
  });
}

async function main() {
  try {
    await runSmoke();
    console.log(
      JSON.stringify(
        {
          status: "ok",
          summary: state.summary
        },
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          status: "failed",
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          summary: state.summary
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    if (!keepResources) {
      await cleanupResources();
    }
  }
}

void main();
