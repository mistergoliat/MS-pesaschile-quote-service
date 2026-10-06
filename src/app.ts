import Fastify, { type FastifyInstance } from "fastify";

import { DependencyMonitor } from "./application/health/dependency-monitor";
import { PrincipalRegistry } from "./infrastructure/auth/principal-registry";
import { principalRegistrySource, type AppEnv } from "./infrastructure/config/env";
import { FilesystemDocumentArtifactStorage } from "./infrastructure/documents/filesystem-document-artifact-storage";
import type { PdfRendererPort } from "./application/quote-v2/document/pdf-renderer-port";
import { NativePdfRenderer } from "./infrastructure/documents/native-pdf-renderer";
import { buildConnectionConfig, PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresDependencyProbe } from "./infrastructure/persistence/postgres/postgres-dependency-probe";
import type { QuoteClock } from "./infrastructure/persistence/postgres/quote-clock";
import { loadMigrationManifest } from "./infrastructure/persistence/postgres/schema-head";
import { ApplicationLifecycleState } from "./infrastructure/runtime/application-lifecycle-state";
import { BackgroundJobManager } from "./infrastructure/runtime/background-job-manager";
import { sendErrorResponse, toHttpError } from "./http/errors";
import { registerRoutes, type BusinessRouteRegistrar } from "./http/routes";
import { v2QuoteRoutes } from "./http/routes/v2-quote-route";

export type ShutdownOutcome = "completed" | "timed_out" | "failed";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
  artifactStorage: FilesystemDocumentArtifactStorage;
  pdfRenderer: PdfRendererPort;
  backgroundJobs: BackgroundJobManager;
  lifecycleState: ApplicationLifecycleState;
  dependencyMonitor: DependencyMonitor;
  principalRegistry: PrincipalRegistry;
  /**
   * Ordered, bounded shutdown: not-ready → stop probes and jobs → close HTTP
   * (drains in-flight requests) → close the database pool. Resolves within
   * APP_SHUTDOWN_TIMEOUT_MS; idempotent.
   */
  shutdown(reason: string): Promise<ShutdownOutcome>;
}

export interface BuildApplicationOverrides {
  readonly pdfRenderer?: PdfRendererPort;
  readonly principalRegistry?: PrincipalRegistry;
  /** Log destination (tests capture logs to prove no secret is written). */
  readonly logStream?: { write(line: string): void };
  /** Additional business routes mounted behind the readiness gate (tests). */
  readonly businessRoutes?: readonly BusinessRouteRegistrar[];
  /** Expiry-projection time source (tests pin it; production uses the database clock). */
  readonly quoteClock?: QuoteClock;
}

/**
 * Builds the application without touching any external dependency. Throws
 * only for local initialization corruption (e.g. packaged migrations that do
 * not match the compiled manifest, a malformed principal registry);
 * dependency availability is the DependencyMonitor's concern.
 *
 * R1.4 state: the V1 API and its workers are retired (their persistence
 * model was replaced by the V2 schema); the V2 API arrives in R1.5. The
 * runtime therefore serves health only, with the readiness gate in place for
 * the business routes to come.
 */
export function buildApplication(
  env: AppEnv,
  overrides: BuildApplicationOverrides = {}
): ApplicationContext {
  const migrationManifest = loadMigrationManifest();
  const principalRegistry = overrides.principalRegistry ?? PrincipalRegistry.load(principalRegistrySource(env));
  const app: FastifyInstance = Fastify({
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    requestTimeout: env.HTTP_REQUEST_TIMEOUT_MS,
    connectionTimeout: env.HTTP_CONNECTION_TIMEOUT_MS,
    keepAliveTimeout: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    logger: {
      level: env.LOG_LEVEL,
      ...(overrides.logStream ? { stream: overrides.logStream } : {})
    },
    routerOptions: {
      maxParamLength: 1024
    }
  });

  const database = new PostgresDatabase(env);
  const artifactStorage = new FilesystemDocumentArtifactStorage(env.QUOTE_DOCUMENT_STORAGE_ROOT);
  // Formal-document identity and versions are code-owned (issuer profile,
  // template v4, renderer profile); no environment value reaches the PDF.
  const pdfRenderer = overrides.pdfRenderer ?? new NativePdfRenderer();
  const lifecycleState = new ApplicationLifecycleState();
  const dependencyMonitor = new DependencyMonitor(
    {
      database: new PostgresDependencyProbe(buildConnectionConfig(env), migrationManifest),
      artifactStorage,
      renderer: pdfRenderer
    },
    lifecycleState,
    {
      intervalMs: env.HEALTH_PROBE_INTERVAL_MS,
      retryMinMs: env.HEALTH_PROBE_RETRY_MIN_MS,
      retryMaxMs: env.HEALTH_PROBE_RETRY_MAX_MS,
      probeTimeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
      expectedSchemaHead: migrationManifest.expectedHead
    },
    app.log
  );
  database.onConnectionError(() => {
    dependencyMonitor.requestProbe();
  });
  const backgroundJobs = new BackgroundJobManager();

  app.decorateRequest("principal", null);

  app.setErrorHandler((error, request, reply) => {
    // A request that hit a dead connection is a cheap, early outage signal.
    if (toHttpError(error).code === "dependency_unavailable") {
      dependencyMonitor.requestProbe();
    }

    return sendErrorResponse(error, request, reply);
  });

  // The first probe cycle runs before the socket binds so readiness reflects
  // reality from the first request. It is bounded by HEALTH_PROBE_TIMEOUT_MS
  // and never throws: an unavailable dependency leaves the process live and
  // not ready instead of failing startup.
  app.addHook("onReady", async () => {
    await dependencyMonitor.probeNow();
  });

  app.addHook("onListen", () => {
    dependencyMonitor.start();
    backgroundJobs.start();
  });

  app.addHook("preClose", async () => {
    lifecycleState.markShuttingDown();
    await dependencyMonitor.stop();
    await backgroundJobs.stop();
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  registerRoutes(app, {
    env,
    monitor: dependencyMonitor,
    principalRegistry,
    backgroundJobs,
    // The email subsystem was retired with V1 and returns in R1.6.
    emailEnabled: false,
    startedAt: new Date(),
    businessRoutes: [
      v2QuoteRoutes(database, { clock: overrides.quoteClock, issuanceDeadlineMs: env.QUOTE_ISSUANCE_DEADLINE_MS }),
      ...(overrides.businessRoutes ?? [])
    ]
  });

  let shutdownPromise: Promise<ShutdownOutcome> | null = null;

  const shutdown = (reason: string): Promise<ShutdownOutcome> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    const startedAtMs = Date.now();
    lifecycleState.markShuttingDown();
    app.log.info(
      { event: "shutdown.started", reason, deadlineMs: env.APP_SHUTDOWN_TIMEOUT_MS },
      "Shutdown started"
    );

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ShutdownOutcome>((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timed_out"), env.APP_SHUTDOWN_TIMEOUT_MS);
      deadlineTimer.unref();
    });

    shutdownPromise = Promise.race([
      app.close().then(
        (): ShutdownOutcome => "completed",
        (): ShutdownOutcome => "failed"
      ),
      deadline
    ]).then((outcome) => {
      clearTimeout(deadlineTimer);
      const payload = {
        event: "shutdown.completed",
        reason,
        outcome,
        durationMs: Date.now() - startedAtMs
      };

      if (outcome === "completed") {
        app.log.info(payload, "Shutdown completed");
      } else {
        app.log.error(payload, "Shutdown did not complete cleanly");
      }

      return outcome;
    });

    return shutdownPromise;
  };

  return {
    app,
    database,
    artifactStorage,
    pdfRenderer,
    backgroundJobs,
    lifecycleState,
    dependencyMonitor,
    principalRegistry,
    shutdown
  };
}
