import crypto from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const configuredBuildTimeoutMs = Number.parseInt(process.env.SMOKE_BUILD_TIMEOUT_MS ?? "", 10);
const BUILD_TIMEOUT_MS = Number.isFinite(configuredBuildTimeoutMs) ? configuredBuildTimeoutMs : 2_700_000;
const PHASE_TIMEOUT_MS = {
  build: BUILD_TIMEOUT_MS,
  cleanup: 180_000,
  network: 30_000,
  postgresStart: 60_000,
  postgresReady: 60_000,
  migrations: 120_000,
  appStart: 60_000,
  health: 15_000,
  readiness: 60_000,
  unauthorized: 15_000,
  create: 30_000,
  read: 15_000,
  issue: 60_000,
  documents: 15_000,
  downloads: 30_000,
  replay: 30_000,
  accept: 30_000,
  restart: 90_000,
  persistence: 30_000,
  expiration: 60_000,
  cleanupOrphan: 60_000,
  gracefulShutdown: 30_000
};

const phaseDefinitions = [
  { key: "cleanup", label: "PHASE 01 cleanup" },
  { key: "network", label: "PHASE 02 network" },
  { key: "postgresStart", label: "PHASE 03 postgres start" },
  { key: "postgresReady", label: "PHASE 04 postgres ready" },
  { key: "migrations", label: "PHASE 05 migrations" },
  { key: "appStart", label: "PHASE 06 app start" },
  { key: "health", label: "PHASE 07 health" },
  { key: "readiness", label: "PHASE 08 readiness" },
  { key: "unauthorized", label: "PHASE 09 unauthorized" },
  { key: "create", label: "PHASE 10 create" },
  { key: "read", label: "PHASE 11 read" },
  { key: "issue", label: "PHASE 12 issue" },
  { key: "documents", label: "PHASE 13 documents" },
  { key: "downloads", label: "PHASE 14 downloads" },
  { key: "replay", label: "PHASE 15 replay" },
  { key: "accept", label: "PHASE 16 accept" },
  { key: "restart", label: "PHASE 17 restart" },
  { key: "persistence", label: "PHASE 18 persistence check" },
  { key: "expiration", label: "PHASE 19 expiration" },
  { key: "cleanupOrphan", label: "PHASE 20 cleanup" },
  { key: "gracefulShutdown", label: "PHASE 21 graceful shutdown" }
];

const imageTag = process.env.SMOKE_IMAGE_TAG ?? "pesaschile-quote-service:t06-smoke";
const postgresImage = process.env.SMOKE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const smokeMode = process.env.SMOKE_MODE ?? "full";
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
    storageRoot: "/var/lib/pesaschile/quote-documents",
    browserPath: "/opt/pesaschile/bin/chrome-headless-shell"
  },
  credentials: {
    serviceAuthToken: `smoke-service-auth-${crypto.randomBytes(16).toString("hex")}`,
    documentRefSecret: crypto.randomBytes(32).toString("hex")
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
    mode: smokeMode,
    phases: [],
    appliedMigrations: [],
    firstQuote: {
      quoteId: null,
      quoteNumber: null,
      status: null,
      version: null,
      pdfDocumentRef: null,
      htmlDocumentRef: null,
      pdfSha256: null,
      htmlSha256: null
    },
    secondQuote: {
      quoteId: null,
      status: null,
      expiredAt: null
    },
    gracefulShutdownExitCode: null
  }
};

const quoteFixture = {
  actor: {
    type: "sales_agent",
    id: "agent-smoke-1"
  },
  source: {
    system: "crm_customer_360",
    correlationId: "corr-smoke-1"
  },
  customerSnapshot: {
    name: "Ana Runtime",
    businessName: "Pesas Chile",
    email: "ana.runtime@example.com",
    phone: "56912345678",
    address: "Av. Runtime 123",
    district: "Santiago",
    region: "RM"
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

function shouldRunPhase(key) {
  if (smokeMode === "core") {
    return new Set([
      "cleanup",
      "network",
      "postgresStart",
      "postgresReady",
      "migrations",
      "appStart",
      "health",
      "readiness",
      "gracefulShutdown"
    ]).has(key);
  }

  if (smokeMode === "docs") {
    return new Set([
      "cleanup",
      "network",
      "postgresStart",
      "postgresReady",
      "migrations",
      "appStart",
      "health",
      "readiness",
      "unauthorized",
      "create",
      "read",
      "issue",
      "documents",
      "downloads",
      "gracefulShutdown"
    ]).has(key);
  }

  return true;
}

function toDockerEnvArgs(envObject) {
  return Object.entries(envObject).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildCreateQuoteBody(validUntil, uniqueValue) {
  return {
    opportunityId: `opp-smoke-${uniqueValue}`,
    customerId: `customer-smoke-${uniqueValue}`,
    conversationId: `conversation-smoke-${uniqueValue}`,
    actor: quoteFixture.actor,
    source: quoteFixture.source,
    currency: "CLP",
    customerSnapshot: quoteFixture.customerSnapshot,
    items: [
      {
        type: "product",
        externalItemId: `sku-product-${uniqueValue}`,
        sku: `SKU-PRODUCT-${uniqueValue}`,
        description: "Bascula industrial 300kg",
        quantity: "2",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19"
      },
      {
        type: "service",
        externalItemId: `svc-install-${uniqueValue}`,
        sku: `SVC-${uniqueValue}`,
        description: "Servicio de calibracion",
        quantity: "1",
        unitPrice: "1000",
        taxIncluded: false,
        taxRate: "0.19"
      }
    ],
    validUntil
  };
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
    SERVICE_AUTH_TOKEN: state.credentials.serviceAuthToken,
    QUOTE_DOCUMENT_REF_SECRET: state.credentials.documentRefSecret,
    QUOTE_DOCUMENT_STORAGE_ROOT: state.paths.storageRoot,
    QUOTE_PDF_EXECUTABLE_PATH: state.paths.browserPath,
    QUOTE_EXPIRATION_SCHEDULER_ENABLED: "true",
    QUOTE_EXPIRATION_INTERVAL_MS: "1000",
    QUOTE_EXPIRATION_BATCH_SIZE: "25",
    QUOTE_DOCUMENT_CLEANUP_ENABLED: "true",
    QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS: "1000",
    QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS: "1000"
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
  const timer = setTimeout(() => {
    controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();

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

async function fetchBytes(path, options = {}) {
  const {
    headers = {},
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();

  try {
    const response = await fetch(`${state.app.baseUrl}${path}`, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      status: response.status,
      headers: response.headers,
      buffer,
      text: buffer.toString("utf8")
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

async function waitForQuoteStatus(quoteId, expectedStatus, authHeader, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const response = await fetchJson(`/v1/quotes/${quoteId}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    lastStatus = response.body?.status ?? String(response.status);

    if (response.body?.status === expectedStatus) {
      return response.body;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Quote ${quoteId} did not reach status ${expectedStatus}; lastStatus=${lastStatus}`);
}

async function waitForOrphanDeletion(relativePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const targetPath = `${state.paths.storageRoot}/${relativePath}`;

  while (Date.now() < deadline) {
    const result = await docker(
      [
        "exec",
        state.app.activeContainer,
        "node",
        "-e",
        "const fs=require('fs');try{fs.accessSync(process.argv[1]);process.exit(0);}catch{process.exit(1);}",
        targetPath
      ],
      {
        allowFailure: true,
        timeoutMs: 10_000
      }
    );

    if (result.code !== 0) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Orphan artifact was not deleted within ${timeoutMs}ms: ${targetPath}`);
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

  if (!shouldRunPhase(key)) {
    state.summary.phases.push({
      phase: label,
      status: "skipped",
      timeoutMs
    });
    log(`${label} SKIPPED timeout=${timeoutMs}ms mode=${smokeMode}`);
    return null;
  }

  const startedAt = Date.now();
  log(`${label} START timeout=${timeoutMs}ms startedAt=${nowIso()}`);

  try {
    const result = await Promise.race([
      work(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} exceeded phase timeout ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      })
    ]);
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

function assertIssuedDocumentReplayMatches(initial, replay) {
  assert(replay.quoteId === initial.quoteId, "Replay changed quoteId");
  assert(replay.quoteNumber === initial.quoteNumber, "Replay changed quoteNumber");
  assert(replay.status === initial.status, "Replay changed status");
  assert(replay.version === initial.version, "Replay changed version");
  assert(replay.issuedDocument.contentHash === initial.issuedDocument.contentHash, "Replay changed contentHash");
  assert(replay.issuedDocument.pdf.documentRef === initial.issuedDocument.pdf.documentRef, "Replay changed PDF ref");
  assert(replay.issuedDocument.pdf.sha256 === initial.issuedDocument.pdf.sha256, "Replay changed PDF SHA");
  assert(replay.issuedDocument.html.documentRef === initial.issuedDocument.html.documentRef, "Replay changed HTML ref");
  assert(replay.issuedDocument.html.sha256 === initial.issuedDocument.html.sha256, "Replay changed HTML SHA");
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
      [
        "run",
        "--rm",
        "--network",
        state.names.network,
        ...toDockerEnvArgs(buildAppEnv()),
        imageTag,
        "npm",
        "run",
        "db:migrate:runtime"
      ],
      {
        timeoutMs: PHASE_TIMEOUT_MS.migrations
      }
    );

    const appliedMigrations = (await queryDatabase("select name from public.schema_migrations order by run_on, name;"))
      .split(/\r?\n/)
      .filter((value) => value.length > 0);
    state.summary.appliedMigrations = appliedMigrations;
    assert(
      appliedMigrations.includes("000001_baseline") &&
        appliedMigrations.includes("000002_quote_persistence"),
      `Expected migrations not found: ${appliedMigrations.join(", ")}`
    );
  });

  await runPhase("appStart", PHASE_TIMEOUT_MS.appStart, async () => {
    await startApp(state.names.appPrimary, PHASE_TIMEOUT_MS.appStart);
  });

  await runPhase("health", PHASE_TIMEOUT_MS.health, async () => {
    const response = await fetchJson("/health", {
      timeoutMs: 5_000
    });
    assert(response.status === 200, `Expected /health 200, got ${response.status}`);
  });

  await runPhase("readiness", PHASE_TIMEOUT_MS.readiness, async () => {
    const body = await waitForReadiness(PHASE_TIMEOUT_MS.readiness);
    assert(body.checks.database.status === "up", "Database was not ready");
    assert(body.checks.storage.status === "up", "Storage was not ready");
    assert(body.checks.pdfRenderer.status === "up", "PDF renderer was not ready");
  });

  await runPhase("unauthorized", PHASE_TIMEOUT_MS.unauthorized, async () => {
    const response = await fetchJson("/v1/quotes", {
      timeoutMs: 5_000
    });
    assert(response.status === 401, `Expected unauthorized 401, got ${response.status}`);
  });

  await runPhase("create", PHASE_TIMEOUT_MS.create, async () => {
    const response = await fetchJson("/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `create-smoke-${suffix}`
      },
      body: buildCreateQuoteBody(new Date(Date.now() + 86_400_000).toISOString(), suffix),
      timeoutMs: 10_000
    });
    assert(response.status === 201, `Expected create 201, got ${response.status}`);
    state.summary.firstQuote.quoteId = response.body.quoteId;
    state.summary.firstQuote.quoteNumber = response.body.quoteNumber;
    state.summary.firstQuote.status = response.body.status;
    state.summary.firstQuote.version = response.body.version;
  });

  await runPhase("read", PHASE_TIMEOUT_MS.read, async () => {
    const response = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    assert(response.status === 200, `Expected read 200, got ${response.status}`);
    assert(response.body.quoteNumber === state.summary.firstQuote.quoteNumber, "Read quote mismatch");
  });

  const issueBody = {
    expectedVersion: 1,
    actor: quoteFixture.actor,
    source: quoteFixture.source
  };
  let firstIssueResponse = null;

  await runPhase("issue", PHASE_TIMEOUT_MS.issue, async () => {
    const response = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}/issue`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `issue-smoke-${suffix}`
      },
      body: issueBody,
      timeoutMs: 20_000
    });
    assert(response.status === 200, `Expected issue 200, got ${response.status}`);
    assert(response.body.status === "issued", `Expected issued, got ${response.body.status}`);
    firstIssueResponse = response.body;
  });

  await runPhase("documents", PHASE_TIMEOUT_MS.documents, async () => {
    const response = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}/documents`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    assert(response.status === 200, `Expected documents 200, got ${response.status}`);
    assert(response.body.available === true, "Documents not available");
    state.summary.firstQuote.pdfDocumentRef = response.body.pdf.documentRef;
    state.summary.firstQuote.htmlDocumentRef = response.body.html.documentRef;
    state.summary.firstQuote.pdfSha256 = response.body.pdf.sha256;
    state.summary.firstQuote.htmlSha256 = response.body.html.sha256;
  });

  await runPhase("downloads", PHASE_TIMEOUT_MS.downloads, async () => {
    const pdf = await fetchBytes(`/v1/documents/${state.summary.firstQuote.pdfDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });
    const html = await fetchBytes(`/v1/documents/${state.summary.firstQuote.htmlDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });

    assert(pdf.status === 200, `Expected PDF 200, got ${pdf.status}`);
    assert(pdf.headers.get("content-type")?.includes("application/pdf"), "Invalid PDF content-type");
    assert(pdf.buffer.subarray(0, 4).toString("utf8") === "%PDF", "Invalid PDF signature");
    assert(sha256(pdf.buffer) === state.summary.firstQuote.pdfSha256, "PDF SHA mismatch");

    assert(html.status === 200, `Expected HTML 200, got ${html.status}`);
    assert(html.headers.get("content-type")?.includes("text/html"), "Invalid HTML content-type");
    assert(sha256(html.buffer) === state.summary.firstQuote.htmlSha256, "HTML SHA mismatch");
    for (const expectedText of [
      state.summary.firstQuote.quoteNumber,
      quoteFixture.customerSnapshot.name,
      "Servicio de calibracion",
      "$11.170"
    ]) {
      assert(html.text.includes(expectedText), `Missing HTML text: ${expectedText}`);
    }
  });

  await runPhase("replay", PHASE_TIMEOUT_MS.replay, async () => {
    const replay = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}/issue`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `issue-smoke-${suffix}`
      },
      body: issueBody,
      timeoutMs: 20_000
    });
    assert(replay.status === 200, `Expected replay 200, got ${replay.status}`);
    assertIssuedDocumentReplayMatches(firstIssueResponse, replay.body);

    const audit = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}/audit?limit=50&offset=0`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    const issuedEvents = audit.body.items.filter((event) => event.action === "issued");
    assert(issuedEvents.length === 1, `Expected one issued event, got ${issuedEvents.length}`);
  });

  await runPhase("accept", PHASE_TIMEOUT_MS.accept, async () => {
    const response = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}/accept`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `accept-smoke-${suffix}`
      },
      body: {
        expectedVersion: 2,
        actor: {
          type: "operator",
          id: "operator-smoke-1"
        },
        source: {
          system: "manual",
          correlationId: "accept-smoke-1"
        }
      },
      timeoutMs: 10_000
    });
    assert(response.status === 200, `Expected accept 200, got ${response.status}`);
    assert(response.body.status === "accepted", `Expected accepted, got ${response.body.status}`);
  });

  await runPhase("restart", PHASE_TIMEOUT_MS.restart, async () => {
    await stopActiveApp();
    state.logs.primaryApp = await readLogs(state.names.appPrimary);
    await startApp(state.names.appRestarted, PHASE_TIMEOUT_MS.restart);
  });

  await runPhase("persistence", PHASE_TIMEOUT_MS.persistence, async () => {
    await waitForReadiness(30_000);
    const quote = await fetchJson(`/v1/quotes/${state.summary.firstQuote.quoteId}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    assert(quote.status === 200, `Expected persisted quote 200, got ${quote.status}`);
    assert(quote.body.status === "accepted", `Expected accepted after restart, got ${quote.body.status}`);

    const pdf = await fetchBytes(`/v1/documents/${state.summary.firstQuote.pdfDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });
    const html = await fetchBytes(`/v1/documents/${state.summary.firstQuote.htmlDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });
    assert(sha256(pdf.buffer) === state.summary.firstQuote.pdfSha256, "Persisted PDF SHA mismatch");
    assert(sha256(html.buffer) === state.summary.firstQuote.htmlSha256, "Persisted HTML SHA mismatch");
  });

  await runPhase("expiration", PHASE_TIMEOUT_MS.expiration, async () => {
    const create = await fetchJson("/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `create-expiring-${suffix}`
      },
      body: buildCreateQuoteBody(new Date(Date.now() + 5_000).toISOString(), `${suffix}-exp`),
      timeoutMs: 10_000
    });
    assert(create.status === 201, `Expected expiring create 201, got ${create.status}`);

    const issue = await fetchJson(`/v1/quotes/${create.body.quoteId}/issue`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `issue-expiring-${suffix}`
      },
      body: issueBody,
      timeoutMs: 20_000
    });
    assert(issue.status === 200, `Expected expiring issue 200, got ${issue.status}`);

    const expired = await waitForQuoteStatus(create.body.quoteId, "expired", authHeader, 30_000);
    state.summary.secondQuote.quoteId = expired.quoteId;
    state.summary.secondQuote.status = expired.status;
    state.summary.secondQuote.expiredAt = expired.timestamps.expiredAt;

    const audit = await fetchJson(`/v1/quotes/${create.body.quoteId}/audit?limit=50&offset=0`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 5_000
    });
    const expiredEvents = audit.body.items.filter((event) => event.action === "expired");
    assert(expiredEvents.length === 1, `Expected one expired event, got ${expiredEvents.length}`);
  });

  await runPhase("cleanupOrphan", PHASE_TIMEOUT_MS.cleanupOrphan, async () => {
    const orphanRelativePath = "quotes/orphan-smoke/manual-orphan.txt";
    await docker(
      [
        "exec",
        state.app.activeContainer,
        "node",
        "-e",
        [
          "const fs=require('fs');",
          "const path=require('path');",
          "const target=path.join(process.argv[1],process.argv[2]);",
          "fs.mkdirSync(path.dirname(target),{recursive:true});",
          "fs.writeFileSync(target,'orphan artifact');",
          "const old=new Date(Date.now()-10000);",
          "fs.utimesSync(target,old,old);"
        ].join(""),
        state.paths.storageRoot,
        orphanRelativePath
      ],
      {
        timeoutMs: 10_000
      }
    );
    await waitForOrphanDeletion(orphanRelativePath, 30_000);

    const pdf = await fetchBytes(`/v1/documents/${state.summary.firstQuote.pdfDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });
    const html = await fetchBytes(`/v1/documents/${state.summary.firstQuote.htmlDocumentRef}`, {
      headers: {
        Authorization: authHeader
      },
      timeoutMs: 10_000
    });
    assert(sha256(pdf.buffer) === state.summary.firstQuote.pdfSha256, "Cleanup removed live PDF");
    assert(sha256(html.buffer) === state.summary.firstQuote.htmlSha256, "Cleanup removed live HTML");
  });

  await runPhase("gracefulShutdown", PHASE_TIMEOUT_MS.gracefulShutdown, async () => {
    await stopActiveApp();

    if (state.app.activeContainer === state.names.appRestarted) {
      state.logs.restartedApp = await readLogs(state.names.appRestarted);
      const exitCode = Number(
        (
          await docker(["inspect", "--format", "{{.State.ExitCode}}", state.names.appRestarted], {
            timeoutMs: 10_000
          })
        ).stdout.trim()
      );
      state.summary.gracefulShutdownExitCode = exitCode;
    } else {
      state.logs.primaryApp = await readLogs(state.names.appPrimary);
      const exitCode = Number(
        (
          await docker(["inspect", "--format", "{{.State.ExitCode}}", state.names.appPrimary], {
            timeoutMs: 10_000
          })
        ).stdout.trim()
      );
      state.summary.gracefulShutdownExitCode = exitCode;
    }

    assert(state.summary.gracefulShutdownExitCode === 0, "Application exit code was not zero");
    const combinedLogs = `${state.logs.primaryApp}\n${state.logs.restartedApp}`;
    assert(combinedLogs.includes("Shutdown signal received"), "Missing shutdown signal log");
    assert(combinedLogs.includes("Application shutdown completed"), "Missing shutdown completed log");

    if (smokeMode === "full") {
      const databaseStatuses = await queryDatabase(
        [
          "select quote_id || ':' || status",
          "from quote_service.quotes",
          `where quote_id in ('${state.summary.firstQuote.quoteId}','${state.summary.secondQuote.quoteId}')`,
          "order by quote_id;"
        ].join(" ")
      );
      assert(
        databaseStatuses.includes(`${state.summary.firstQuote.quoteId}:accepted`) &&
          databaseStatuses.includes(`${state.summary.secondQuote.quoteId}:expired`),
        `Unexpected final statuses: ${databaseStatuses}`
      );
    }
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
