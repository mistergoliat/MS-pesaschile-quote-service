import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";

const imageTag = process.env.SMOKE_IMAGE_TAG ?? "pesaschile-quote-service:t06-smoke";
const postgresImage = process.env.SMOKE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const skipBuild = process.env.SMOKE_SKIP_BUILD === "1";
const keepResources = process.env.SMOKE_KEEP_RESOURCES === "1";
const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
const networkName = `quote-smoke-net-${suffix}`;
const volumeName = `quote-documents-smoke-${suffix}`;
const dbContainerName = `quote-smoke-db-${suffix}`;
const appContainerName = `quote-smoke-app-a-${suffix}`;
const restartedAppContainerName = `quote-smoke-app-b-${suffix}`;
const serviceAuthToken = `smoke-service-auth-${crypto.randomBytes(16).toString("hex")}`;
const documentRefSecret = crypto.randomBytes(32).toString("hex");
const storageRoot = "/var/lib/pesaschile/quote-documents";
const browserPath = "/opt/pesaschile/bin/chrome-headless-shell";
const startedContainers = new Set();
process.on("uncaughtException", (error) => {
  console.log("[docker-smoke] uncaughtException");
  console.log(error instanceof Error ? error.stack ?? error.message : String(error));
});
process.on("unhandledRejection", (reason) => {
  console.log("[docker-smoke] unhandledRejection");
  console.log(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});
process.on("exit", (code) => {
  console.log(`[docker-smoke] process exit ${code}`);
});
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

const summary = {
  imageTag,
  imageId: null,
  appliedMigrations: [],
  firstQuote: {
    quoteId: null,
    quoteNumber: null,
    version: null,
    pdfSha256: null,
    htmlSha256: null
  },
  secondQuote: {
    quoteId: null,
    status: null,
    expiredAt: null
  },
  gracefulShutdownExitCode: null
};

function log(message) {
  console.log(`[docker-smoke] ${message}`);
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

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatIsoOffset(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a free port")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function run(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    allowFailure = false,
    stdin = null
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            [
              `Command failed: ${command} ${args.join(" ")}`,
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
        stdout,
        stderr
      });
    });

    if (stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function docker(args, options = {}) {
  return run("docker", args, options);
}

async function cleanupDockerResource(kind, name) {
  await docker([kind, "rm", "-f", name], {
    allowFailure: true
  }).catch(() => undefined);
}

async function cleanupNetwork(name) {
  await docker(["network", "rm", name], {
    allowFailure: true
  }).catch(() => undefined);
}

async function cleanupVolume(name) {
  await docker(["volume", "rm", "-f", name], {
    allowFailure: true
  }).catch(() => undefined);
}

async function waitForContainerHealth(containerName, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await docker(
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", containerName],
      {
        allowFailure: true
      }
    );
    const status = result.stdout.trim();

    if (status === "healthy") {
      return;
    }

    if (status === "unhealthy") {
      throw new Error(`Container ${containerName} became unhealthy`);
    }

    await sleep(1_000);
  }

  throw new Error(`Container ${containerName} did not become healthy within ${timeoutMs}ms`);
}

async function waitForHttpReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(baseUrl, "GET", "/health/ready");

      if (response.status === 200) {
        const body = response.body;

        assert(body.status === "ready", "Readiness body did not report ready");
        return body;
      }
    } catch {
      // Retry until timeout.
    }

    await sleep(1_000);
  }

  throw new Error(`Readiness did not become green within ${timeoutMs}ms`);
}

async function waitForQuoteStatus(baseUrl, quoteId, expectedStatus, authHeader, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetchJson(baseUrl, "GET", `/v1/quotes/${quoteId}`, {
      headers: {
        Authorization: authHeader
      }
    });

    if (response.body.status === expectedStatus) {
      return response.body;
    }

    await sleep(1_000);
  }

  throw new Error(`Quote ${quoteId} did not reach status ${expectedStatus} within ${timeoutMs}ms`);
}

async function waitForOrphanDeletion(containerName, relativePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await docker(
      [
        "exec",
        containerName,
        "node",
        "-e",
        "const fs=require('fs');try{fs.accessSync(process.argv[1]);process.exit(0);}catch{process.exit(1);}",
        `${storageRoot}/${relativePath}`
      ],
      {
        allowFailure: true
      }
    );

    if (result.code !== 0) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Orphaned artifact ${relativePath} was not deleted within ${timeoutMs}ms`);
}

async function fetchJson(baseUrl, method, path, options = {}) {
  const { headers = {}, body } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;

  return {
    status: response.status,
    headers: response.headers,
    body: parsed
  };
}

async function fetchBytes(baseUrl, path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    status: response.status,
    headers: response.headers,
    buffer,
    text: buffer.toString("utf8")
  };
}

function buildCreateQuoteBody(validUntil, suffixValue) {
  return {
    opportunityId: `opp-smoke-${suffixValue}`,
    customerId: `customer-smoke-${suffixValue}`,
    conversationId: `conversation-smoke-${suffixValue}`,
    actor: quoteFixture.actor,
    source: quoteFixture.source,
    currency: "CLP",
    customerSnapshot: quoteFixture.customerSnapshot,
    items: [
      {
        type: "product",
        externalItemId: `sku-product-${suffixValue}`,
        sku: `SKU-PRODUCT-${suffixValue}`,
        description: "Bascula industrial 300kg",
        quantity: "2",
        unitPrice: "4990",
        taxIncluded: true,
        taxRate: "0.19"
      },
      {
        type: "service",
        externalItemId: `svc-install-${suffixValue}`,
        sku: `SVC-${suffixValue}`,
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

function assertIssuedDocumentReplayMatches(initialResponseBody, replayResponseBody) {
  assert(replayResponseBody.quoteId === initialResponseBody.quoteId, "Replay changed quoteId");
  assert(replayResponseBody.quoteNumber === initialResponseBody.quoteNumber, "Replay changed quoteNumber");
  assert(replayResponseBody.status === initialResponseBody.status, "Replay changed quote status");
  assert(replayResponseBody.version === initialResponseBody.version, "Replay changed quote version");
  assert(
    replayResponseBody.issuedDocument.available === initialResponseBody.issuedDocument.available,
    "Replay changed issuedDocument availability"
  );
  assert(
    replayResponseBody.issuedDocument.contentHash === initialResponseBody.issuedDocument.contentHash,
    "Replay changed issued document contentHash"
  );
  assert(
    replayResponseBody.issuedDocument.renderVersion === initialResponseBody.issuedDocument.renderVersion,
    "Replay changed renderVersion"
  );
  assert(
    replayResponseBody.issuedDocument.pdf.documentRef === initialResponseBody.issuedDocument.pdf.documentRef,
    "Replay changed PDF documentRef"
  );
  assert(
    replayResponseBody.issuedDocument.pdf.sha256 === initialResponseBody.issuedDocument.pdf.sha256,
    "Replay changed PDF SHA-256"
  );
  assert(
    replayResponseBody.issuedDocument.html.documentRef === initialResponseBody.issuedDocument.html.documentRef,
    "Replay changed HTML documentRef"
  );
  assert(
    replayResponseBody.issuedDocument.html.sha256 === initialResponseBody.issuedDocument.html.sha256,
    "Replay changed HTML SHA-256"
  );
}

async function startPostgres() {
  log(`Starting PostgreSQL container ${dbContainerName}`);
  await docker([
    "run",
    "-d",
    "--name",
    dbContainerName,
    "--network",
    networkName,
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
  ]);
  startedContainers.add(dbContainerName);
  await waitForContainerHealth(dbContainerName);
}

async function startApplicationContainer(containerName, hostPort, appEnv) {
  log(`Starting application container ${containerName} on port ${hostPort}`);
  await docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    networkName,
    "-p",
    `127.0.0.1:${hostPort}:3000`,
    "-v",
    `${volumeName}:${storageRoot}`,
    ...toDockerEnvArgs(appEnv),
    imageTag
  ]);
  startedContainers.add(containerName);
}

function toDockerEnvArgs(envObject) {
  return Object.entries(envObject).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

async function readLogs(containerName) {
  const result = await docker(["logs", containerName], {
    allowFailure: true
  });

  return `${result.stdout}${result.stderr}`;
}

async function queryDatabase(sql) {
  const result = await docker([
    "exec",
    dbContainerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "quote_smoke",
    "-At",
    "-c",
    sql
  ]);

  return result.stdout.trim();
}

async function inspectContainerState(containerName) {
  const result = await docker(
    ["inspect", "--format", "{{.State.Status}}/{{.State.ExitCode}}", containerName],
    {
      allowFailure: true
    }
  );

  return result.stdout.trim();
}

async function main() {
  const hostPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  const authHeader = `Bearer ${serviceAuthToken}`;
  const databaseUrl = `postgres://postgres:postgres@${dbContainerName}:5432/quote_smoke`;
  const appEnv = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3000",
    LOG_LEVEL: "info",
    DATABASE_URL: databaseUrl,
    DATABASE_SSL_MODE: "disable",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-smoke",
    SERVICE_AUTH_TOKEN: serviceAuthToken,
    QUOTE_DOCUMENT_REF_SECRET: documentRefSecret,
    QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
    QUOTE_PDF_EXECUTABLE_PATH: browserPath,
    QUOTE_EXPIRATION_SCHEDULER_ENABLED: "true",
    QUOTE_EXPIRATION_INTERVAL_MS: "1000",
    QUOTE_EXPIRATION_BATCH_SIZE: "25",
    QUOTE_DOCUMENT_CLEANUP_ENABLED: "true",
    QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS: "1000",
    QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS: "1000"
  };
  let appLogs;
  let restartedAppLogs;

  try {
    if (skipBuild) {
      log(`Reusing existing Docker image ${imageTag}`);
    } else {
      log(`Building Docker image ${imageTag} with --no-cache`);
      await docker(["build", "--no-cache", "-t", imageTag, "."]);
    }
    summary.imageId = (
      await docker(["image", "inspect", imageTag, "--format", "{{.Id}}"])
    ).stdout.trim();

    log(`Creating network ${networkName}`);
    await docker(["network", "create", networkName]);
    log(`Creating volume ${volumeName}`);
    await docker(["volume", "create", volumeName]);

    await startPostgres();

    log("Running migrations inside the runtime image");
    await docker([
      "run",
      "--rm",
      "--network",
      networkName,
      ...toDockerEnvArgs(appEnv),
      imageTag,
      "npm",
      "run",
      "db:migrate:runtime"
    ]);

    const appliedMigrations = (await queryDatabase("select name from public.schema_migrations order by run_on, name;"))
      .split(/\r?\n/)
      .filter((value) => value.length > 0);
    summary.appliedMigrations = appliedMigrations;
    assert(
      appliedMigrations.includes("000001_baseline") &&
        appliedMigrations.includes("000002_quote_persistence"),
      `Expected baseline migrations to be applied, got ${appliedMigrations.join(", ")}`
    );

    await startApplicationContainer(appContainerName, hostPort, appEnv);
    const readyBody = await waitForHttpReady(baseUrl);
    assert(readyBody.checks.database.status === "up", "Database was not ready");
    assert(readyBody.checks.storage.status === "up", "Storage was not ready");
    assert(readyBody.checks.pdfRenderer.status === "up", "PDF renderer was not ready");
    log("Readiness confirmed");

    const liveness = await fetchJson(baseUrl, "GET", "/health");
    assert(liveness.status === 200, `Expected /health 200, got ${liveness.status}`);
    log("Liveness confirmed");

    const unauthorized = await fetchJson(baseUrl, "GET", "/v1/quotes");
    assert(unauthorized.status === 401, `Expected unauthorized list to return 401, got ${unauthorized.status}`);
    log("Unauthorized access confirmed");

    const createDraftIdempotencyKey = `create-smoke-${suffix}`;
    const issueIdempotencyKey = `issue-smoke-${suffix}`;
    log("Creating first draft quote");
    const createDraftResponse = await fetchJson(baseUrl, "POST", "/v1/quotes", {
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": createDraftIdempotencyKey
      },
      body: buildCreateQuoteBody(formatIsoOffset(86_400_000), suffix)
    });
    assert(createDraftResponse.status === 201, `Expected create draft 201, got ${createDraftResponse.status}`);
    assert(createDraftResponse.body.status === "draft", `Expected draft status, got ${createDraftResponse.body.status}`);
    summary.firstQuote.quoteId = createDraftResponse.body.quoteId;
    summary.firstQuote.quoteNumber = createDraftResponse.body.quoteNumber;
    summary.firstQuote.version = createDraftResponse.body.version;
    log(`Draft created: ${summary.firstQuote.quoteId}`);

    const readDraftResponse = await fetchJson(baseUrl, "GET", `/v1/quotes/${summary.firstQuote.quoteId}`, {
      headers: {
        Authorization: authHeader
      }
    });
    assert(readDraftResponse.status === 200, `Expected read draft 200, got ${readDraftResponse.status}`);
    assert(
      readDraftResponse.body.quoteNumber === summary.firstQuote.quoteNumber,
      "Read quote number did not match created draft"
    );
    log("Draft read confirmed");

    const issueBody = {
      expectedVersion: 1,
      actor: quoteFixture.actor,
      source: quoteFixture.source
    };
    const issueResponse = await fetchJson(baseUrl, "POST", `/v1/quotes/${summary.firstQuote.quoteId}/issue`, {
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": issueIdempotencyKey
      },
      body: issueBody
    });
    assert(issueResponse.status === 200, `Expected issue 200, got ${issueResponse.status}`);
    assert(issueResponse.body.status === "issued", `Expected issued status, got ${issueResponse.body.status}`);
    assert(issueResponse.body.issuedDocument.available === true, "Issued document was not available");
    log("Quote issuance confirmed");

    const documentsResponse = await fetchJson(
      baseUrl,
      "GET",
      `/v1/quotes/${summary.firstQuote.quoteId}/documents`,
      {
        headers: {
          Authorization: authHeader
        }
      }
    );
    assert(documentsResponse.status === 200, `Expected documents 200, got ${documentsResponse.status}`);
    assert(documentsResponse.body.available === true, "Documents endpoint did not report available=true");
    log("Document metadata confirmed");

    const pdfRef = documentsResponse.body.pdf.documentRef;
    const htmlRef = documentsResponse.body.html.documentRef;
    assert(typeof pdfRef === "string" && pdfRef.length > 0, "Missing PDF documentRef");
    assert(typeof htmlRef === "string" && htmlRef.length > 0, "Missing HTML documentRef");

    const pdfDownload = await fetchBytes(baseUrl, `/v1/documents/${pdfRef}`, {
      Authorization: authHeader
    });
    assert(pdfDownload.status === 200, `Expected PDF download 200, got ${pdfDownload.status}`);
    assert(
      pdfDownload.headers.get("content-type")?.includes("application/pdf"),
      "PDF content-type was not application/pdf"
    );
    assert(pdfDownload.buffer.byteLength > 100, "PDF download was unexpectedly empty");
    assert(pdfDownload.buffer.subarray(0, 4).toString("utf8") === "%PDF", "PDF header signature mismatch");
    summary.firstQuote.pdfSha256 = sha256(pdfDownload.buffer);
    assert(
      summary.firstQuote.pdfSha256 === documentsResponse.body.pdf.sha256,
      "PDF SHA-256 did not match persisted metadata"
    );
    assert(
      pdfDownload.headers.get("x-document-sha256") === documentsResponse.body.pdf.sha256,
      "PDF response header SHA-256 did not match persisted metadata"
    );
    log("PDF download confirmed");

    const htmlDownload = await fetchBytes(baseUrl, `/v1/documents/${htmlRef}`, {
      Authorization: authHeader
    });
    assert(htmlDownload.status === 200, `Expected HTML download 200, got ${htmlDownload.status}`);
    assert(
      htmlDownload.headers.get("content-type")?.includes("text/html"),
      "HTML content-type was not text/html"
    );
    assert(htmlDownload.buffer.byteLength > 100, "HTML download was unexpectedly empty");
    summary.firstQuote.htmlSha256 = sha256(htmlDownload.buffer);
    assert(
      summary.firstQuote.htmlSha256 === documentsResponse.body.html.sha256,
      "HTML SHA-256 did not match persisted metadata"
    );
    for (const expectedText of [
      summary.firstQuote.quoteNumber,
      quoteFixture.customerSnapshot.name,
      "Servicio de calibracion",
      "$11.170"
    ]) {
      assert(
        htmlDownload.text.includes(expectedText),
        `HTML document did not contain expected text: ${expectedText}`
      );
    }
    log("HTML download confirmed");

    const replayIssueResponse = await fetchJson(
      baseUrl,
      "POST",
      `/v1/quotes/${summary.firstQuote.quoteId}/issue`,
      {
        headers: {
          Authorization: authHeader,
          "Idempotency-Key": issueIdempotencyKey
        },
        body: issueBody
      }
    );
    assert(replayIssueResponse.status === 200, `Expected replayed issue 200, got ${replayIssueResponse.status}`);
    assertIssuedDocumentReplayMatches(issueResponse.body, replayIssueResponse.body);
    log("Issue replay confirmed");

    const firstQuoteAudit = await fetchJson(
      baseUrl,
      "GET",
      `/v1/quotes/${summary.firstQuote.quoteId}/audit?limit=50&offset=0`,
      {
        headers: {
          Authorization: authHeader
        }
      }
    );
    const issuedEvents = firstQuoteAudit.body.items.filter((event) => event.action === "issued");
    assert(issuedEvents.length === 1, `Expected exactly one issued audit event, got ${issuedEvents.length}`);
    log("Issued audit confirmed");

    const acceptResponse = await fetchJson(baseUrl, "POST", `/v1/quotes/${summary.firstQuote.quoteId}/accept`, {
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
      }
    });
    assert(acceptResponse.status === 200, `Expected accept 200, got ${acceptResponse.status}`);
    assert(acceptResponse.body.status === "accepted", `Expected accepted status, got ${acceptResponse.body.status}`);
    log("Accept confirmed");

    log(`Restarting the application using the same image ${imageTag}`);
    await docker(["stop", "--time", "10", appContainerName]);
    appLogs = await readLogs(appContainerName);

    await startApplicationContainer(restartedAppContainerName, hostPort, appEnv);
    await waitForHttpReady(baseUrl);

    const persistedQuote = await fetchJson(
      baseUrl,
      "GET",
      `/v1/quotes/${summary.firstQuote.quoteId}`,
      {
        headers: {
          Authorization: authHeader
        }
      }
    );
    assert(persistedQuote.status === 200, `Expected persisted quote read 200, got ${persistedQuote.status}`);
    assert(persistedQuote.body.status === "accepted", `Expected accepted after restart, got ${persistedQuote.body.status}`);
    log("Restart persistence confirmed");

    const persistedDocuments = await fetchJson(
      baseUrl,
      "GET",
      `/v1/quotes/${summary.firstQuote.quoteId}/documents`,
      {
        headers: {
          Authorization: authHeader
        }
      }
    );
    assert(
      persistedDocuments.body.pdf.sha256 === summary.firstQuote.pdfSha256,
      "Persisted PDF metadata changed after restart"
    );
    assert(
      persistedDocuments.body.html.sha256 === summary.firstQuote.htmlSha256,
      "Persisted HTML metadata changed after restart"
    );

    const persistedPdf = await fetchBytes(baseUrl, `/v1/documents/${pdfRef}`, {
      Authorization: authHeader
    });
    const persistedHtml = await fetchBytes(baseUrl, `/v1/documents/${htmlRef}`, {
      Authorization: authHeader
    });
    assert(sha256(persistedPdf.buffer) === summary.firstQuote.pdfSha256, "Persisted PDF bytes changed after restart");
    assert(sha256(persistedHtml.buffer) === summary.firstQuote.htmlSha256, "Persisted HTML bytes changed after restart");

    const expiringQuoteDraft = await fetchJson(baseUrl, "POST", "/v1/quotes", {
      headers: {
        Authorization: authHeader,
        "Idempotency-Key": `create-expiring-${suffix}`
      },
      body: buildCreateQuoteBody(formatIsoOffset(5_000), `${suffix}-exp`)
    });
    assert(expiringQuoteDraft.status === 201, `Expected expiring draft 201, got ${expiringQuoteDraft.status}`);

    const expiringIssueResponse = await fetchJson(
      baseUrl,
      "POST",
      `/v1/quotes/${expiringQuoteDraft.body.quoteId}/issue`,
      {
        headers: {
          Authorization: authHeader,
          "Idempotency-Key": `issue-expiring-${suffix}`
        },
        body: {
          expectedVersion: 1,
          actor: quoteFixture.actor,
          source: quoteFixture.source
        }
      }
    );
    assert(expiringIssueResponse.status === 200, `Expected expiring issue 200, got ${expiringIssueResponse.status}`);

    const expiredQuote = await waitForQuoteStatus(
      baseUrl,
      expiringQuoteDraft.body.quoteId,
      "expired",
      authHeader
    );
    summary.secondQuote.quoteId = expiredQuote.quoteId;
    summary.secondQuote.status = expiredQuote.status;
    summary.secondQuote.expiredAt = expiredQuote.timestamps.expiredAt;
    assert(typeof expiredQuote.timestamps.expiredAt === "string", "expiredAt was not populated");
    log("Automatic expiration confirmed");

    const expiringAudit = await fetchJson(
      baseUrl,
      "GET",
      `/v1/quotes/${expiringQuoteDraft.body.quoteId}/audit?limit=50&offset=0`,
      {
        headers: {
          Authorization: authHeader
        }
      }
    );
    const expiredEvents = expiringAudit.body.items.filter((event) => event.action === "expired");
    assert(expiredEvents.length === 1, `Expected exactly one expired audit event, got ${expiredEvents.length}`);
    log("Expiration audit confirmed");

    const orphanRelativePath = "quotes/orphan-smoke/manual-orphan.txt";
    log(`Creating orphaned artifact ${orphanRelativePath} inside the mounted volume`);
    await docker([
      "exec",
      restartedAppContainerName,
      "node",
      "-e",
      [
        "const fs=require('fs');",
        "const path=require('path');",
        "const target=path.join(process.argv[1],process.argv[2]);",
        "fs.mkdirSync(path.dirname(target),{recursive:true});",
        "fs.writeFileSync(target,'orphan artifact created by docker smoke');",
        "const old=new Date(Date.now()-10000);",
        "fs.utimesSync(target,old,old);",
        "console.log(target);"
      ].join(""),
      storageRoot,
      orphanRelativePath
    ]);
    await waitForOrphanDeletion(restartedAppContainerName, orphanRelativePath);
    log("Orphan cleanup confirmed");

    const livePdfAfterCleanup = await fetchBytes(baseUrl, `/v1/documents/${pdfRef}`, {
      Authorization: authHeader
    });
    const liveHtmlAfterCleanup = await fetchBytes(baseUrl, `/v1/documents/${htmlRef}`, {
      Authorization: authHeader
    });
    assert(
      sha256(livePdfAfterCleanup.buffer) === summary.firstQuote.pdfSha256,
      "Live PDF was affected by orphan cleanup"
    );
    assert(
      sha256(liveHtmlAfterCleanup.buffer) === summary.firstQuote.htmlSha256,
      "Live HTML was affected by orphan cleanup"
    );
    log("Live documents survived cleanup");

    log("Stopping application container with SIGTERM");
    await docker(["stop", "--time", "10", restartedAppContainerName]);
    restartedAppLogs = await readLogs(restartedAppContainerName);
    summary.gracefulShutdownExitCode = Number(
      (
        await docker(["inspect", "--format", "{{.State.ExitCode}}", restartedAppContainerName])
      ).stdout.trim()
    );
    assert(summary.gracefulShutdownExitCode === 0, "Application did not exit cleanly after SIGTERM");
    assert(
      restartedAppLogs.includes("Shutdown signal received") &&
        restartedAppLogs.includes("Application shutdown completed"),
      "Graceful shutdown logs were not emitted"
    );
    log("Graceful shutdown confirmed");

    const databaseStatuses = await queryDatabase(
      [
        "select quote_id || ':' || status",
        "from quote_service.quotes",
        `where quote_id in ('${summary.firstQuote.quoteId}','${summary.secondQuote.quoteId}')`,
        "order by quote_id;"
      ].join(" ")
    );
    assert(
      databaseStatuses.includes(`${summary.firstQuote.quoteId}:accepted`) &&
        databaseStatuses.includes(`${summary.secondQuote.quoteId}:expired`),
      `Unexpected final quote statuses in PostgreSQL: ${databaseStatuses}`
    );
    log("PostgreSQL integrity confirmed");

    const combinedLogs = `${appLogs ?? ""}\n${restartedAppLogs ?? ""}`;
    for (const forbidden of [
      "migration file missing",
      "node-pg-migrate missing",
      "chromium executable missing",
      "permission denied",
      "unhandled rejection"
    ]) {
      assert(
        !combinedLogs.toLowerCase().includes(forbidden),
        `Found forbidden log pattern: ${forbidden}`
      );
    }
    for (const secretOrPii of [
      serviceAuthToken,
      documentRefSecret,
      quoteFixture.customerSnapshot.email,
      quoteFixture.customerSnapshot.phone
    ]) {
      assert(!combinedLogs.includes(secretOrPii), `Found sensitive value in logs: ${secretOrPii}`);
    }

    log("Docker smoke completed successfully");
    console.log(
      JSON.stringify(
        {
          status: "ok",
          summary
        },
        null,
        2
      )
    );
  } catch (error) {
    const failureMessage = error instanceof Error ? error.stack ?? error.message : String(error);
    const debugPayload = {};

    for (const containerName of [appContainerName, restartedAppContainerName, dbContainerName]) {
      if (!startedContainers.has(containerName)) {
        continue;
      }

      debugPayload[containerName] = {
        state: await inspectContainerState(containerName),
        logs: await readLogs(containerName)
      };
    }

    console.log("[docker-smoke] FAILED");
    console.log(failureMessage);
    console.log(
      JSON.stringify(
        {
          summary,
          debugPayload
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    for (const containerName of [restartedAppContainerName, appContainerName, dbContainerName]) {
      if (!keepResources && startedContainers.has(containerName)) {
        await cleanupDockerResource("container", containerName);
      }
    }

    if (!keepResources) {
      await cleanupNetwork(networkName);
      await cleanupVolume(volumeName);
    }
  }
}

const keepAliveTimer = setInterval(() => undefined, 1_000);

void main()
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAliveTimer);
  });
