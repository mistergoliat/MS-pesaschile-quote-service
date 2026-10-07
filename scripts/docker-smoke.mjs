import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const configuredBuildTimeoutMs = Number.parseInt(process.env.SMOKE_BUILD_TIMEOUT_MS ?? "", 10);
const BUILD_TIMEOUT_MS = Number.isFinite(configuredBuildTimeoutMs) ? configuredBuildTimeoutMs : 2_700_000;
// R1.4: the V1 API was retired with its persistence model and the V2 API
// arrives in R1.5, so this smoke covers the runtime that exists: image build,
// explicit migration to the V2 head, schema check, liveness/readiness/
// dependency health, V2 create/draft/issue, V2 reads, reconciliation and
// cancel (R1.5A.4), V1 routes gone, restart with persisted state, graceful
// shutdown. R1.5B3: formal issuance end to end in the Linux image: inline
// 201/200 with a large sync budget, the content-addressed PDF verified inside
// the container against its manifest, then a restart with budget 0 where the
// background worker issues a 202 quote, with no duplicate manifest.
// R1.5B4: GET /v2/quotes/{id}/document byte-exact (also across the restart and
// for the async quote), then adversarial windows in the PRODUCTION image, which
// contains no failpoint code: PostgreSQL locks hold issuance exactly where a
// crash is wanted and the container is SIGKILLed (docker kill):
//   - after the content-addressed PDF is published, inside T5 before COMMIT
//     (SHARE lock on quote_documents) → restart, lease expiry, reclaim,
//     EEXIST reuse, issued once;
//   - after T5 COMMIT, before the HTTP response (ACCESS EXCLUSIVE lock on
//     quote_lines, which T5 never touches but the response rebuild reads) →
//     restart, same-key retry returns the same issued quote and document;
// then a tampered and a missing artifact (503 document_storage_failed, never
// regenerated) and the integrity verifier inside the image.
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
  v2Create: 30_000,
  v2Draft: 30_000,
  v2ReadCancel: 30_000,
  v1Retired: 15_000,
  restart: 90_000,
  asyncIssuance: 60_000,
  crashBeforeCommit: 120_000,
  crashAfterCommit: 120_000,
  integrity: 60_000,
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
  { key: "v2Create", label: "PHASE 11 v2 create-and-issue" },
  { key: "v2Draft", label: "PHASE 12 v2 draft, edit and issue" },
  { key: "v2ReadCancel", label: "PHASE 13 v2 read, reconcile and cancel" },
  { key: "v1Retired", label: "PHASE 14 v1 retired" },
  { key: "restart", label: "PHASE 15 restart" },
  { key: "asyncIssuance", label: "PHASE 16 async issuance after restart" },
  { key: "crashBeforeCommit", label: "PHASE 17 kill after publication, before T5 commit" },
  { key: "crashAfterCommit", label: "PHASE 18 kill after T5 commit, before the response" },
  { key: "integrity", label: "PHASE 19 tampered and missing artifacts" },
  { key: "gracefulShutdown", label: "PHASE 20 graceful shutdown" }
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
    appRestarted: `quote-smoke-app-b-${suffix}`,
    appCrashBefore: `quote-smoke-app-c-${suffix}`,
    appRecoverBefore: `quote-smoke-app-d-${suffix}`,
    appCrashAfter: `quote-smoke-app-e-${suffix}`,
    appFinal: `quote-smoke-app-f-${suffix}`
  },
  paths: {
    storageRoot: "/var/lib/pesaschile/quote-documents"
  },
  credentials: {
    // Monitoring principal for /health/dependencies (registry stores only the hash).
    serviceAuthToken: crypto.randomBytes(32).toString("base64url"),
    // Transactional caller with quotes:create.
    salesToken: crypto.randomBytes(32).toString("base64url"),
    // Manual-flow operator: drafts, issues, reads, audits and cancels its own quotes.
    backofficeToken: crypto.randomBytes(32).toString("base64url"),
    // Supervisor with quotes:read:any (reads everything) and quotes:cancel (own quotes only, A4).
    supervisorToken: crypto.randomBytes(32).toString("base64url")
  },
  app: {
    hostPort: null,
    baseUrl: null,
    activeContainer: null,
    // Large inline budget for the primary app; the restarted app uses 0 (async only).
    syncBudgetMs: "10000"
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
        },
        {
          principalId: "smoke-sales",
          principalType: "service",
          scopes: ["quotes:create", "quotes:read", "quotes:document:read"],
          tokenSha256: [crypto.createHash("sha256").update(state.credentials.salesToken).digest("hex")]
        },
        {
          principalId: "smoke-backoffice",
          principalType: "operator",
          scopes: ["quotes:draft:write", "quotes:issue", "quotes:read", "quotes:cancel", "quotes:audit:read"],
          tokenSha256: [crypto.createHash("sha256").update(state.credentials.backofficeToken).digest("hex")]
        },
        {
          principalId: "smoke-supervisor",
          principalType: "operator",
          scopes: ["quotes:read", "quotes:read:any", "quotes:document:read", "quotes:cancel", "quotes:audit:read"],
          tokenSha256: [crypto.createHash("sha256").update(state.credentials.supervisorToken).digest("hex")]
        }
      ]
    }),
    QUOTE_DOCUMENT_STORAGE_ROOT: state.paths.storageRoot,
    QUOTE_ISSUANCE_SYNC_BUDGET_MS: state.app.syncBudgetMs,
    QUOTE_ISSUANCE_POLL_INTERVAL_MS: "500",
    // Minimum lease: a killed holder's operation is reclaimable 10 s later.
    QUOTE_ISSUANCE_LEASE_MS: "10000"
  };
}

/** The quote's manifest, and the SHA-256/length of the bytes at its storage key, read inside the app container. */
async function verifyArtifact(quoteId) {
  const row = await queryDatabase(
    `select storage_key || ' ' || pdf_sha256 || ' ' || byte_length || ' ' || (select count(*) from quote_service.quote_documents where quote_id = '${quoteId}') from quote_service.quote_documents where quote_id = '${quoteId}';`
  );
  const [storageKey, pdfSha256, byteLength, manifests] = row.split(" ");
  assert(manifests === "1", `Expected exactly one manifest for ${quoteId}, found ${manifests}`);
  assert(storageKey === `artifacts/sha256/${pdfSha256.slice(0, 2)}/${pdfSha256.slice(2, 4)}/${pdfSha256}.pdf`, `Storage key is not content addressed: ${storageKey}`);
  const hashed = (
    await docker(
      [
        "exec",
        state.app.activeContainer,
        "node",
        "-e",
        "const b=require('fs').readFileSync(process.argv[1]);process.stdout.write(require('crypto').createHash('sha256').update(b).digest('hex')+' '+b.length)",
        `${state.paths.storageRoot}/${storageKey}`
      ],
      { timeoutMs: 20_000 }
    )
  ).stdout.trim();
  assert(hashed === `${pdfSha256} ${byteLength}`, `Stored PDF does not match its manifest: ${hashed} vs ${pdfSha256} ${byteLength}`);
  return { storageKey, pdfSha256, byteLength: Number(byteLength) };
}

/** GET /v2/quotes/{id}/document: raw bytes and headers. */
async function fetchDocument(quoteId, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("HTTP timeout")), DEFAULT_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${state.app.baseUrl}/v2/quotes/${quoteId}/document`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** The document endpoint serves exactly the manifest's verified bytes, with the frozen headers. */
async function verifyDocumentEndpoint(quoteId, token = state.credentials.salesToken) {
  const manifest = await verifyArtifact(quoteId);
  const document = await fetchDocument(quoteId, token);
  const sha = crypto.createHash("sha256").update(document.bytes).digest("hex");
  assert(document.status === 200, `GET document ${quoteId}: ${document.status} ${document.bytes.toString("utf8").slice(0, 200)}`);
  assert(sha === manifest.pdfSha256 && document.bytes.length === manifest.byteLength, `Served bytes differ from the manifest for ${quoteId}`);
  assert(document.headers.get("content-type") === "application/pdf", "Document Content-Type");
  assert(document.headers.get("x-document-sha256") === manifest.pdfSha256, "X-Document-Sha256 header");
  assert(document.headers.get("etag") === `"${manifest.pdfSha256}"`, "ETag header");
  assert(/^attachment; filename="PC-[0-9]{6,}\.pdf"$/.test(document.headers.get("content-disposition") ?? ""), "Content-Disposition header");
  const headerText = JSON.stringify([...document.headers.entries()]);
  assert(!headerText.includes("artifacts/") && !headerText.includes(state.paths.storageRoot), "Document headers leaked a storage path");
  return { ...manifest, bytes: document.bytes };
}

/** Runs node inside a throwaway container of the image with the document volume mounted (works while the app is dead). */
async function inVolume(script, args = []) {
  const result = await docker(
    ["run", "--rm", "-v", `${state.names.volume}:${state.paths.storageRoot}`, "--entrypoint", "node", imageTag, "-e", script, ...args],
    { timeoutMs: 60_000 }
  );
  return result.stdout.trim();
}

/**
 * A psql session in the postgres container that holds a lock until released:
 * begin; <statement>; then waits. release() rolls back and ends the session.
 */
async function holdLock(statement) {
  const child = spawn("docker", ["exec", "-i", state.names.postgres, "psql", "-U", "postgres", "-d", "quote_smoke", "-At", "-v", "ON_ERROR_STOP=1"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write(`begin;\n${statement};\nselect 'lock-held';\n`);
  const deadline = Date.now() + 20_000;

  while (!output.includes("lock-held")) {
    assert(Date.now() < deadline, `Lock not acquired: ${output}`);
    assert(child.exitCode === null, `psql exited: ${output}`);
    await sleep(100);
  }

  return {
    async release() {
      child.stdin.end("rollback;\n\\q\n");
      await Promise.race([exited, sleep(10_000)]);
      if (child.exitCode === null) {
        child.kill();
      }
    }
  };
}

async function waitForQuery(sql, expected, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() < deadline) {
    last = await queryDatabase(sql);

    if (last === expected) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`${message}: expected ${expected}, last ${last}`);
}

/** SIGKILL the active app container (docker kill): no shutdown hook, no finally block runs. */
async function killActiveApp() {
  const container = state.app.activeContainer;
  await docker(["kill", container], { timeoutMs: 30_000 });
  state.logs[container] = await readLogs(container);
  const status = await inspectContainer(container);
  assert(status.startsWith("exited/137"), `Expected a SIGKILLed container (137), got ${status}`);
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
  const match = /^quote-smoke-(?:db|app-[a-f])-(.+)$/.exec(containerName);
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

  for (const containerName of [...state.containersStarted]) {
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
      appliedMigrations.at(-1) === "000009_quote_snapshot_child_insert_guard",
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
      details.body.schema.expectedHead === "000009_quote_snapshot_child_insert_guard" &&
        details.body.schema.actualHead === details.body.schema.expectedHead,
      `Unexpected schema head: ${JSON.stringify(details.body.schema)}`
    );
    assert(!details.text.includes("postgres://"), "Dependency details leaked a DSN");
    assert(!details.text.includes(state.credentials.serviceAuthToken), "Dependency details leaked the credential");
  });

  await runPhase("v2Create", PHASE_TIMEOUT_MS.v2Create, async () => {
    const body = JSON.parse(readFileSync("docs/v2/examples/create-and-issue.request.json", "utf8"));
    const headers = { Authorization: `Bearer ${state.credentials.salesToken}`, "Idempotency-Key": `smoke-${suffix}` };
    const created = await fetchJson("/v2/quotes", { method: "POST", headers: { ...headers, "X-Correlation-Id": "smoke-1" }, body, timeoutMs: 10_000 });
    // R1.5B3: healthy dependencies and a 10 s inline budget → formally issued before the response.
    assert(created.status === 201, `Expected 201, got ${created.status}: ${created.text}`);
    assert(created.body.quote.status === "issued" && created.body.operation.status === "succeeded", "Created quote is not issued/succeeded");
    assert(created.body.quote.document.available === true && /^[0-9a-f]{64}$/.test(created.body.quote.document.pdfSha256), "Issued quote has no document");
    assert(/^PC-[0-9]{6,}$/.test(created.body.quote.quoteNumber), "Quote number missing");
    state.summary.v2Quote = { quoteId: created.body.quote.quoteId, quoteNumber: created.body.quote.quoteNumber, operationId: created.body.operation.operationId };
    const artifact = await verifyArtifact(created.body.quote.quoteId);
    assert(artifact.pdfSha256 === created.body.quote.document.pdfSha256 && artifact.byteLength === created.body.quote.document.byteLength, "Response document disagrees with the manifest");
    state.summary.v2Quote.pdfSha256 = artifact.pdfSha256;
    // R1.5B4: the document endpoint serves exactly these bytes.
    await verifyDocumentEndpoint(created.body.quote.quoteId);

    const replay = await fetchJson("/v2/quotes", { method: "POST", headers: { ...headers, "X-Correlation-Id": "smoke-2" }, body, timeoutMs: 10_000 });
    assert(replay.status === 201 && replay.headers.get("idempotent-replay") === "true", `Replay failed: ${replay.status}`);
    assert(
      replay.body.quote.quoteId === created.body.quote.quoteId &&
        replay.body.quote.quoteNumber === created.body.quote.quoteNumber &&
        replay.body.operation.operationId === created.body.operation.operationId,
      "Replay returned a different quote"
    );

    const changed = { ...body, lines: [{ ...body.lines[0], quantity: { value: "3", unit: "unit" } }], expectedTotals: undefined };
    const conflict = await fetchJson("/v2/quotes", { method: "POST", headers, body: changed, timeoutMs: 10_000 });
    assert(conflict.status === 409 && conflict.body.error.code === "idempotency_key_conflict", `Expected 409, got ${conflict.status}`);
    const quotes = (await queryDatabase("select count(*) from quote_service.quotes;")).trim();
    assert(quotes === "1", `Expected exactly one quote, found ${quotes}`);
  });

  await runPhase("v2Draft", PHASE_TIMEOUT_MS.v2Draft, async () => {
    const example = (name) => JSON.parse(readFileSync(`docs/v2/examples/${name}`, "utf8"));
    const auth = { Authorization: `Bearer ${state.credentials.backofficeToken}` };
    const draft = await fetchJson("/v2/quotes/drafts", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": `smoke-draft-${suffix}` },
      body: example("draft-create.request.json"),
      timeoutMs: 10_000
    });
    assert(draft.status === 201, `Expected 201, got ${draft.status}: ${draft.text}`);
    assert(draft.body.status === "draft" && draft.body.version === 1, "Draft is not draft v1");
    assert(draft.body.quoteNumber === null && draft.body.validity === null && draft.body.issuance === null, "Draft has a number, validity or issuance");
    const quoteId = draft.body.quoteId;

    const updated = await fetchJson(`/v2/quotes/${quoteId}/draft`, {
      method: "PATCH",
      headers: { ...auth, "Idempotency-Key": `smoke-update-${suffix}` },
      body: example("draft-update.request.json"),
      timeoutMs: 10_000
    });
    assert(updated.status === 200 && updated.body.version === 2, `Draft update failed: ${updated.status}`);

    const issueHeaders = { ...auth, "Idempotency-Key": `smoke-issue-${suffix}` };
    const issued = await fetchJson(`/v2/quotes/${quoteId}/issue`, { method: "POST", headers: issueHeaders, body: example("issue.request.json"), timeoutMs: 10_000 });
    assert(issued.status === 200, `Expected 200, got ${issued.status}: ${issued.text}`);
    assert(issued.body.quote.quoteId === quoteId, "Issue changed the quoteId");
    assert(/^PC-[0-9]{6,}$/.test(issued.body.quote.quoteNumber), "Quote number missing after issue");
    assert(issued.body.quote.status === "issued" && issued.body.operation.status === "succeeded", "Issued draft is not issued/succeeded");
    state.summary.v2Draft = { quoteId, quoteNumber: issued.body.quote.quoteNumber, operationId: issued.body.operation.operationId };
    await verifyArtifact(quoteId);

    const replay = await fetchJson(`/v2/quotes/${quoteId}/issue`, { method: "POST", headers: issueHeaders, body: example("issue.request.json"), timeoutMs: 10_000 });
    assert(replay.status === 200 && replay.headers.get("idempotent-replay") === "true", `Issue replay failed: ${replay.status}`);
    assert(
      replay.body.quote.quoteNumber === issued.body.quote.quoteNumber && replay.body.operation.operationId === issued.body.operation.operationId,
      "Issue replay returned different ids"
    );
    const counts = (await queryDatabase("select count(*) || ':' || (select count(*) from quote_service.issuance_operations) from quote_service.quotes;")).trim();
    assert(counts === "2:2", `Expected 2 quotes and 2 operations, found ${counts}`);
  });

  await runPhase("v2ReadCancel", PHASE_TIMEOUT_MS.v2ReadCancel, async () => {
    const example = (name) => JSON.parse(readFileSync(`docs/v2/examples/${name}`, "utf8"));
    const as = (token) => ({ Authorization: `Bearer ${token}` });
    const sales = as(state.credentials.salesToken);
    const backoffice = as(state.credentials.backofficeToken);
    const supervisor = as(state.credentials.supervisorToken);
    const { quoteId, quoteNumber, operationId } = state.summary.v2Quote;

    // GET quote / operation: issued with its document, same identifiers as create-and-issue.
    const quote = await fetchJson(`/v2/quotes/${quoteId}`, { headers: sales });
    assert(quote.status === 200, `GET quote: ${quote.status} ${quote.text}`);
    assert(
      quote.body.status === "issued" && quote.body.quoteNumber === quoteNumber && quote.body.issuance.operationId === operationId,
      "GET quote disagrees with create-and-issue"
    );
    assert(quote.body.document.available === true && quote.body.document.pdfSha256 === state.summary.v2Quote.pdfSha256, "Issued quote document disagrees");
    const operation = await fetchJson(`/v2/operations/${operationId}`, { headers: sales });
    assert(operation.status === 200 && operation.body.status === "succeeded" && operation.body.quoteId === quoteId, `GET operation: ${operation.text}`);

    // Visibility: without read:any a foreign quote is a 404 like a missing one; read:any sees it.
    const hidden = await fetchJson(`/v2/quotes/${quoteId}`, { headers: backoffice });
    assert(hidden.status === 404 && hidden.body.error.code === "quote_not_found", `Expected hidden quote, got ${hidden.status}`);
    const anyReader = await fetchJson(`/v2/quotes/${quoteId}`, { headers: supervisor });
    assert(anyReader.status === 200 && anyReader.body.quoteId === quoteId, `read:any GET failed: ${anyReader.status}`);

    // External-correlation list.
    const query = Object.entries(example("create-and-issue.request.json").externalCorrelation)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("&");
    const listed = await fetchJson(`/v2/quotes?${query}`, { headers: sales });
    assert(listed.status === 200 && listed.body.items.length === 1 && listed.body.items[0].quoteId === quoteId, `List failed: ${listed.text}`);
    assert(listed.body.nextCursor === null, "Unexpected next cursor");
    const foreignList = await fetchJson(`/v2/quotes?${query}`, { headers: backoffice });
    assert(foreignList.status === 200 && foreignList.body.items.length === 0, "List leaked a foreign quote");

    // Idempotency lookup reconciles to the same quote and operation; never across principals.
    const lookup = await fetchJson("/v2/idempotency/current?operation=quote.create_and_issue", {
      headers: { ...sales, "Idempotency-Key": `smoke-${suffix}` }
    });
    assert(
      lookup.status === 200 &&
        lookup.body.state === "bound" &&
        lookup.body.binding.quoteId === quoteId &&
        lookup.body.binding.operationId === operationId &&
        lookup.body.binding.quoteStatus === "issued",
      `Lookup failed: ${lookup.text}`
    );
    assert(!lookup.text.includes(`smoke-${suffix}`), "Lookup echoed the raw key");
    const foreignLookup = await fetchJson("/v2/idempotency/current?operation=quote.create_and_issue", {
      headers: { ...supervisor, "Idempotency-Key": `smoke-${suffix}` }
    });
    assert(foreignLookup.status === 200 && foreignLookup.body.state === "not_found", "Lookup crossed principals");

    // Fresh draft → cancel (creator only, A4) → replay → GET cancelled → one audit event.
    const draft = await fetchJson("/v2/quotes/drafts", {
      method: "POST",
      headers: { ...backoffice, "Idempotency-Key": `smoke-cancel-draft-${suffix}` },
      body: example("draft-create.request.json")
    });
    assert(draft.status === 201, `Draft for cancel failed: ${draft.status}`);
    const cancelPath = `/v2/quotes/${draft.body.quoteId}/cancel`;
    const cancelBody = { expectedVersion: 1, reasonCode: "customer_declined" };
    const foreignCancel = await fetchJson(cancelPath, {
      method: "POST",
      headers: { ...supervisor, "Idempotency-Key": `smoke-cancel-${suffix}` },
      body: cancelBody
    });
    assert(foreignCancel.status === 404 && foreignCancel.body.error.code === "quote_not_found", `read:any cancelled: ${foreignCancel.status}`);
    const cancelHeaders = { ...backoffice, "Idempotency-Key": `smoke-cancel-${suffix}` };
    const cancelled = await fetchJson(cancelPath, { method: "POST", headers: cancelHeaders, body: cancelBody });
    assert(cancelled.status === 200, `Cancel failed: ${cancelled.status} ${cancelled.text}`);
    assert(
      cancelled.body.status === "cancelled" && cancelled.body.version === 2 && cancelled.body.quoteNumber === null,
      "Cancelled draft has a wrong state or a number"
    );
    const cancelReplay = await fetchJson(cancelPath, { method: "POST", headers: cancelHeaders, body: cancelBody });
    assert(cancelReplay.status === 200 && cancelReplay.headers.get("idempotent-replay") === "true", "Cancel replay failed");
    const reread = await fetchJson(`/v2/quotes/${draft.body.quoteId}`, { headers: backoffice });
    assert(
      reread.status === 200 && reread.body.status === "cancelled" && reread.body.cancellation.initiatedBy === "smoke-backoffice",
      "GET cancelled quote failed"
    );
    const audit = await fetchJson(`/v2/quotes/${draft.body.quoteId}/audit`, { headers: backoffice });
    assert(audit.status === 200 && audit.body.items.filter((event) => event.type === "quote.cancelled").length === 1, `Audit failed: ${audit.text}`);

    const counts = (await queryDatabase("select count(*) || ':' || (select count(*) from quote_service.issuance_operations) from quote_service.quotes;")).trim();
    assert(counts === "3:2", `Expected 3 quotes and 2 operations, found ${counts}`);
  });

  await runPhase("v1Retired", PHASE_TIMEOUT_MS.v1Retired, async () => {
    const response = await fetchJson("/v1/quotes", { headers: { Authorization: authHeader }, timeoutMs: 5_000 });
    assert(response.status === 404, `Expected retired V1 route to be absent (404), got ${response.status}`);
  });

  await runPhase("restart", PHASE_TIMEOUT_MS.restart, async () => {
    await stopActiveApp();
    state.logs.primaryApp = await readLogs(state.names.appPrimary);
    state.app.syncBudgetMs = "0";
    await startApp(state.names.appRestarted, PHASE_TIMEOUT_MS.restart);
    await waitForReadiness(60_000);
    // Issued quotes are stable across the restart: same manifest, same verified bytes.
    const artifact = await verifyArtifact(state.summary.v2Quote.quoteId);
    assert(artifact.pdfSha256 === state.summary.v2Quote.pdfSha256, "Issued document changed across restart");
    await verifyArtifact(state.summary.v2Draft.quoteId);
    // Same document served after the restart (read:any principal for the foreign quote).
    const served = await verifyDocumentEndpoint(state.summary.v2Quote.quoteId);
    assert(served.pdfSha256 === state.summary.v2Quote.pdfSha256, "Served document changed across restart");
    await verifyDocumentEndpoint(state.summary.v2Draft.quoteId, state.credentials.supervisorToken);
  });

  await runPhase("asyncIssuance", PHASE_TIMEOUT_MS.asyncIssuance, async () => {
    const body = JSON.parse(readFileSync("docs/v2/examples/create-and-issue.request.json", "utf8"));
    const headers = { Authorization: `Bearer ${state.credentials.salesToken}`, "Idempotency-Key": `smoke-async-${suffix}` };
    const created = await fetchJson("/v2/quotes", { method: "POST", headers, body, timeoutMs: 10_000 });
    assert(created.status === 202, `Expected 202 with budget 0, got ${created.status}: ${created.text}`);
    assert(created.body.quote.status === "issuing", "Budget-0 quote is not issuing");
    const quoteId = created.body.quote.quoteId;
    const deadline = Date.now() + 45_000;
    let status = "issuing";

    while (Date.now() < deadline && status !== "issued") {
      await sleep(500);
      status = (await fetchJson(`/v2/quotes/${quoteId}`, { headers: { Authorization: headers.Authorization } })).body.status;
    }

    assert(status === "issued", `Background worker did not issue the quote (status ${status})`);
    await verifyDocumentEndpoint(quoteId);
    const counts = (
      await queryDatabase(
        "select count(*) || ':' || (select count(*) from quote_service.issuance_operations where status = 'succeeded') || ':' || (select count(*) from quote_service.quote_documents) from quote_service.quotes;"
      )
    ).trim();
    assert(counts === "4:3:3", `Expected 4 quotes, 3 succeeded operations and 3 manifests, found ${counts}`);
    state.summary.v2Async = { quoteId, quoteNumber: created.body.quote.quoteNumber };
  });


  await runPhase("crashBeforeCommit", PHASE_TIMEOUT_MS.crashBeforeCommit, async () => {
    // The restarted app (budget 0) is replaced by one with a large inline budget.
    await stopActiveApp();
    state.logs[state.names.appRestarted] = await readLogs(state.names.appRestarted);
    state.app.syncBudgetMs = "10000";
    await startApp(state.names.appCrashBefore, PHASE_TIMEOUT_MS.appStart);
    await waitForReadiness(60_000);

    // T5 inserts the manifest: a SHARE lock on quote_documents holds it inside its transaction.
    const lock = await holdLock("lock table quote_service.quote_documents in share mode");
    const body = JSON.parse(readFileSync("docs/v2/examples/create-and-issue.request.json", "utf8"));
    const headers = { Authorization: `Bearer ${state.credentials.salesToken}`, "Idempotency-Key": `smoke-crash-before-${suffix}` };
    const pending = fetchJson("/v2/quotes", { method: "POST", headers, body, timeoutMs: 60_000 }).catch((error) => ({ error: String(error) }));
    await waitForQuery(
      "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'insert into quote_service.quote_documents%';",
      "1",
      30_000,
      "T5 did not reach the manifest insert"
    );
    const quoteId = await queryDatabase("select quote_id from quote_service.quotes where quote_id not in (select quote_id from quote_service.quote_documents) and status = 'issuing' order by created_at desc limit 1;");
    const operationId = await queryDatabase(`select current_operation_id from quote_service.quotes where quote_id = '${quoteId}';`);
    // The formal PDF is already published at its content address; the manifest is not committed.
    const published = await inVolume(
      "const fs=require('fs'),p=require('path');const r=process.argv[1]+'/artifacts/sha256';const out=[];const w=d=>{for(const e of fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}):[]){const f=p.join(d,e.name);e.isDirectory()?w(f):out.push(p.relative(process.argv[1],f)+' '+fs.statSync(f).mtimeMs)}};w(r);console.log(out.sort().join('\\n'))",
      [state.paths.storageRoot]
    );
    const expectedFiles = Number(await queryDatabase("select count(distinct pdf_sha256) from quote_service.quote_documents;")) + 1;
    assert(published.split("\n").filter(Boolean).length === expectedFiles, `Expected the new PDF published before T5 (files: ${published})`);

    await killActiveApp();
    await lock.release();
    const response = await pending;
    assert(response.error !== undefined || response.status === 202, `The killed request must not report issued: ${JSON.stringify(response.status)}`);
    assert((await queryDatabase(`select count(*) from quote_service.quote_documents where quote_id = '${quoteId}';`)) === "0", "A manifest committed although T5 was killed");
    assert((await queryDatabase(`select status || ':' || generation from quote_service.issuance_operations where operation_id = '${operationId}';`)) === "running:1", "Operation is not the killed holder's running generation");
    assert((await queryDatabase(`select status from quote_service.quotes where quote_id = '${quoteId}';`)) === "issuing", "Quote left issuing");

    // Recovery: a new container reclaims after lease expiry and reuses the published file.
    state.app.syncBudgetMs = "0";
    await startApp(state.names.appRecoverBefore, PHASE_TIMEOUT_MS.appStart);
    await waitForReadiness(60_000);
    await waitForQuery(`select status from quote_service.quotes where quote_id = '${quoteId}';`, "issued", 60_000, "Reclaim did not issue the quote");
    assert((await queryDatabase(`select status || ':' || generation from quote_service.issuance_operations where operation_id = '${operationId}';`)) === "succeeded:2", "Expected success at generation 2");
    const manifest = await verifyDocumentEndpoint(quoteId);
    const after = await inVolume(
      "const fs=require('fs');console.log(fs.statSync(process.argv[1]).mtimeMs)",
      [`${state.paths.storageRoot}/${manifest.storageKey}`]
    );
    assert(published.includes(`${manifest.storageKey} ${after}`), "The reclaim did not reuse the untouched published file");
    const logs = await readLogs(state.names.appRecoverBefore);
    assert(/"event":"issuance\.artifact_published"[^\n]*"reused":true/.test(logs), "Reclaim did not report reusing the artifact");
    assert((await queryDatabase(`select count(*) from quote_service.quote_audit_events where quote_id = '${quoteId}' and event_type = 'quote.issued';`)) === "1", "Issued more than once");
    state.summary.crashBeforeCommit = { quoteId, operationId, pdfSha256: manifest.pdfSha256 };
  });

  await runPhase("crashAfterCommit", PHASE_TIMEOUT_MS.crashAfterCommit, async () => {
    await stopActiveApp();
    state.logs[state.names.appRecoverBefore] = await readLogs(state.names.appRecoverBefore);
    state.app.syncBudgetMs = "10000";
    await startApp(state.names.appCrashAfter, PHASE_TIMEOUT_MS.appStart);
    await waitForReadiness(60_000);

    const documentsLock = await holdLock("lock table quote_service.quote_documents in share mode");
    const body = JSON.parse(readFileSync("docs/v2/examples/create-and-issue.request.json", "utf8"));
    body.externalCorrelation = { ...body.externalCorrelation, externalReference: `smoke-after-${suffix}` };
    const key = `smoke-crash-after-${suffix}`;
    const headers = { Authorization: `Bearer ${state.credentials.salesToken}`, "Idempotency-Key": key };
    const pending = fetchJson("/v2/quotes", { method: "POST", headers, body, timeoutMs: 60_000 }).catch((error) => ({ error: String(error) }));
    await waitForQuery(
      "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'insert into quote_service.quote_documents%';",
      "1",
      30_000,
      "T5 did not reach the manifest insert"
    );
    // The response is rebuilt from durable state and reads quote_lines; T5 never touches it.
    const linesLock = await holdLock("lock table quote_service.quote_lines in access exclusive mode");
    await documentsLock.release();
    const quoteId = await queryDatabase(`select quote_id from quote_service.quotes where external_reference = 'smoke-after-${suffix}';`);
    await waitForQuery(`select status from quote_service.quotes where quote_id = '${quoteId}';`, "issued", 30_000, "T5 did not commit");
    await sleep(500);
    await killActiveApp();
    await linesLock.release();
    const lost = await pending;
    assert(lost.error !== undefined, `The response must have been lost with the process, got ${JSON.stringify(lost.status)}`);
    const committed = await queryDatabase(
      `select q.quote_number || ':' || q.current_operation_id || ':' || d.pdf_sha256 || ':' || (select count(*) from quote_service.issuance_operations) || ':' || (select count(*) from quote_service.quote_documents) from quote_service.quotes q join quote_service.quote_documents d using (quote_id) where q.quote_id = '${quoteId}';`
    );

    state.app.syncBudgetMs = "10000";
    await startApp(state.names.appFinal, PHASE_TIMEOUT_MS.appStart);
    await waitForReadiness(60_000);
    const retry = await fetchJson("/v2/quotes", { method: "POST", headers, body, timeoutMs: 20_000 });
    assert(retry.status === 201 && retry.headers.get("idempotent-replay") === "true", `Retry after the lost response: ${retry.status} ${retry.text}`);
    const [quoteNumber, operationId, pdfSha256] = committed.split(":");
    assert(
      retry.body.quote.quoteId === quoteId &&
        retry.body.quote.quoteNumber === quoteNumber &&
        retry.body.quote.status === "issued" &&
        retry.body.operation.operationId === operationId &&
        retry.body.operation.status === "succeeded" &&
        retry.body.quote.document.pdfSha256 === pdfSha256,
      "Retry did not return the committed issued quote"
    );
    const served = await verifyDocumentEndpoint(quoteId);
    assert(served.pdfSha256 === pdfSha256, "Served document differs from the committed manifest");
    const counts = await queryDatabase(
      "select (select count(*) from quote_service.issuance_operations) || ':' || (select count(*) from quote_service.quote_documents);"
    );
    assert(counts === committed.split(":").slice(3).join(":"), `The retry created new work: ${counts} vs ${committed}`);
    state.summary.crashAfterCommit = { quoteId, quoteNumber, operationId };
  });

  await runPhase("integrity", PHASE_TIMEOUT_MS.integrity, async () => {
    const tampered = await verifyArtifact(state.summary.v2Quote.quoteId);
    const missing = await verifyArtifact(state.summary.v2Draft.quoteId);
    const manifestsBefore = await queryDatabase("select string_agg(document_id || pdf_sha256 || byte_length, ',' order by document_id) from quote_service.quote_documents;");
    const quotesBefore = await queryDatabase("select string_agg(quote_id || status || version, ',' order by quote_id) from quote_service.quotes;");
    await docker(
      ["exec", state.app.activeContainer, "node", "-e", "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);b[b.length-10]^=1;fs.writeFileSync(process.argv[1],b)", `${state.paths.storageRoot}/${tampered.storageKey}`],
      { timeoutMs: 20_000 }
    );
    await docker(["exec", state.app.activeContainer, "node", "-e", "require('fs').rmSync(process.argv[1])", `${state.paths.storageRoot}/${missing.storageKey}`], { timeoutMs: 20_000 });

    for (const [quoteId, token] of [[state.summary.v2Quote.quoteId, state.credentials.salesToken], [state.summary.v2Draft.quoteId, state.credentials.supervisorToken]]) {
      const response = await fetchDocument(quoteId, token);
      const text = response.bytes.toString("utf8");
      assert(response.status === 503, `Expected 503 for a corrupt/missing artifact, got ${response.status}`);
      assert(JSON.parse(text).error.code === "document_storage_failed", `Unexpected error: ${text}`);
      assert(response.headers.get("retry-after") !== null, "503 without Retry-After");
      assert(!text.includes("%PDF") && !text.includes("artifacts/") && !text.includes(state.paths.storageRoot), "503 body leaked bytes or paths");
    }

    // Nothing was regenerated or changed: quotes, manifests and the missing file stay as they are.
    assert((await queryDatabase("select string_agg(document_id || pdf_sha256 || byte_length, ',' order by document_id) from quote_service.quote_documents;")) === manifestsBefore, "Manifests changed");
    assert((await queryDatabase("select string_agg(quote_id || status || version, ',' order by quote_id) from quote_service.quotes;")) === quotesBefore, "Quotes changed");
    const stillMissing = await docker(["exec", state.app.activeContainer, "node", "-e", "process.stdout.write(String(require('fs').existsSync(process.argv[1])))", `${state.paths.storageRoot}/${missing.storageKey}`], { timeoutMs: 20_000 });
    assert(stillMissing.stdout.trim() === "false", "The missing artifact was regenerated");
    const logs = await readLogs(state.app.activeContainer);
    assert((logs.match(/"event":"document\.integrity_failed"/g) ?? []).length === 2, "Expected two operator integrity signals");

    // Operator integrity command inside the image: exit 2 with categorized ids, no paths.
    const verify = await docker(["exec", state.app.activeContainer, "npm", "run", "--silent", "documents:verify:runtime"], { timeoutMs: 60_000, allowFailure: true });
    const report = JSON.parse(verify.stdout.slice(verify.stdout.indexOf("{")));
    assert(verify.code === 2, `documents:verify exit ${verify.code}`);
    const statuses = Object.fromEntries(report.problems.map((problem) => [problem.quoteId, problem.status]));
    assert(statuses[state.summary.v2Quote.quoteId] === "HASH_MISMATCH" && statuses[state.summary.v2Draft.quoteId] === "MISSING", `Verifier report: ${verify.stdout}`);
    assert(report.ok === report.checked - 2, `Other artifacts must verify: ${verify.stdout}`);
    assert(!verify.stdout.includes("artifacts/") && !verify.stdout.includes(state.paths.storageRoot), "Verifier output leaked paths");
    state.summary.integrity = { byStatus: report.byStatus };
  });

  await runPhase("gracefulShutdown", PHASE_TIMEOUT_MS.gracefulShutdown, async () => {
    await stopActiveApp();
    state.logs.restartedApp = await readLogs(state.app.activeContainer);
    state.summary.gracefulShutdownExitCode = Number(
      (await docker(["inspect", "--format", "{{.State.ExitCode}}", state.app.activeContainer], { timeoutMs: 10_000 })).stdout.trim()
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
