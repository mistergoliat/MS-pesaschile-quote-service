import fsPromises from "node:fs/promises";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import { DependencyMonitor } from "./application/health/dependency-monitor";
import type { DeliveryFailpoints } from "./application/quote-v2/delivery/delivery-failpoints";
import { DeliveryWorker } from "./application/quote-v2/delivery/delivery-worker";
import type { MailSenderPort } from "./application/quote-v2/delivery/mail-sender-port";
import { ProviderHealthTracker } from "./application/quote-v2/delivery/provider-health";
import { documentFileName } from "./application/quote-v2/document/document-file-name";
import { PrincipalRegistry } from "./infrastructure/auth/principal-registry";
import type { PdfRendererPort } from "./application/quote-v2/document/pdf-renderer-port";
import { InlineIssuance } from "./application/quote-v2/inline-issuance";
import type { IssuanceFailpoints } from "./application/quote-v2/issuance-failpoints";
import { createIssuanceAttemptBody } from "./application/quote-v2/issuance-attempt";
import { createWorkerInstanceId } from "./application/quote-v2/issuance-worker";
import {
  DELIVERY_COMPLETION_MARGIN_MS,
  DELIVERY_DOCUMENT_READ_TIMEOUT_MS,
  deliverySettings,
  gmailSettings,
  issuanceSettings,
  principalRegistrySource,
  type AppEnv
} from "./infrastructure/config/env";
import { FilesystemContentAddressedArtifactStore } from "./infrastructure/documents/content-addressed-artifact-store";
import { NativePdfRenderer } from "./infrastructure/documents/native-pdf-renderer";
import { GmailMailSender } from "./infrastructure/email/gmail-mail-sender";
import { renderEmailEnvelopeHtml } from "./infrastructure/email/quote-email-envelope-template";
import { PostgresIssuanceOperationRepository } from "./infrastructure/persistence/postgres/issuance-operations";
import { buildConnectionConfig, PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresDependencyProbe } from "./infrastructure/persistence/postgres/postgres-dependency-probe";
import type { QuoteClock } from "./infrastructure/persistence/postgres/quote-clock";
import { PostgresDeliveryRepository } from "./infrastructure/persistence/postgres/quote-v2-delivery-execution";
import { loadMigrationManifest } from "./infrastructure/persistence/postgres/schema-head";
import { ApplicationLifecycleState } from "./infrastructure/runtime/application-lifecycle-state";
import { BackgroundJobManager } from "./infrastructure/runtime/background-job-manager";
import { createDeliveryJobs, type DeliveryJobs } from "./infrastructure/runtime/delivery-jobs";
import { createIssuanceJobs, type IssuanceJobs } from "./infrastructure/runtime/issuance-jobs";
import { isOperationActive } from "./infrastructure/persistence/postgres/quote-v2-reads";
import { sendErrorResponse, toHttpError } from "./http/errors";
import { registerRoutes, type BusinessRouteRegistrar } from "./http/routes";
import { v2DeliveryRoutes } from "./http/routes/v2-delivery-route";
import { v2QuoteRoutes } from "./http/routes/v2-quote-route";

export type ShutdownOutcome = "completed" | "timed_out" | "failed";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
  artifactStorage: FilesystemContentAddressedArtifactStore;
  pdfRenderer: PdfRendererPort;
  backgroundJobs: BackgroundJobManager;
  /** Null only when a test disabled issuance execution. */
  issuance: IssuanceJobs | null;
  /** Null only when a test disabled delivery execution. */
  delivery: DeliveryJobs | null;
  /** The composed mail sender (null: email disabled). */
  mailSender: MailSenderPort | null;
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
  /**
   * Test seam: build without issuance execution (no periodic worker, no
   * deadline sweep, no inline attempt), so acceptance-only suites observe
   * quotes in `issuing`. Production always runs issuance.
   */
  readonly disableIssuanceExecution?: boolean;
  /**
   * Test seam (R1.5B4 crash harness): issuance checkpoints where a test
   * composition stops or holds the process. Production never passes it.
   */
  readonly issuanceFailpoints?: IssuanceFailpoints;
  /**
   * Test seam: the mail sender to compose INSTEAD of the configured provider
   * (a fake, or the Gmail adapter pointed at a local fake provider). With it,
   * delivery requests are accepted and the send runner calls it. Production
   * never passes it: the only production senders come from
   * QUOTE_EMAIL_PROVIDER (`disabled` → none, `gmail` → GmailMailSender), and
   * no configuration value selects a fake.
   */
  readonly testMailSender?: MailSenderPort;
  /**
   * Test seam: build without delivery execution (no send runner, no
   * expired-lease sweep), so request-only suites observe deliveries in
   * `pending`. Production always composes the sweep, and the send runner
   * whenever a sender is configured.
   */
  readonly disableDeliveryExecution?: boolean;
  /** Test seam (R1.6B crash harness): delivery checkpoints. Production never passes it. */
  readonly deliveryFailpoints?: DeliveryFailpoints;
}

/*
 * TEST SEAMS. `BuildApplicationOverrides` is the only way to change issuance
 * or delivery behaviour for tests: `disableIssuanceExecution`,
 * `issuanceFailpoints`, `testMailSender`, `disableDeliveryExecution` and
 * `deliveryFailpoints` are constructor arguments, not configuration. `src/server.ts` (the only production composition) calls
 * `buildApplication(env)` without overrides, no environment variable maps to
 * any of them (env.ts), and no HTTP route reaches them.
 * test/unit/test-seams.test.ts enforces this.
 */

/**
 * Builds the application without touching any external dependency. Throws
 * only for local initialization corruption (e.g. packaged migrations that do
 * not match the compiled manifest, a malformed principal registry);
 * dependency availability is the DependencyMonitor's concern.
 *
 * R1.5B3 state: the V2 API (acceptance, drafts, reads, cancel) and durable
 * issuance run here: the issuance worker (gated on full readiness), the
 * deadline sweep (gated on persistence readiness only) and the bounded
 * inline attempt after acceptance. Formal documents are published to the
 * content-addressed store and committed with the fenced T5 transaction.
 * R1.5B4: `GET /v2/quotes/{id}/document` serves the committed, verified
 * bytes from the same store (read only; never re-rendered).
 * R1.6B: explicitly requested email deliveries are executed by the delivery
 * worker (when a sender is configured) and expired `sending` leases are
 * resolved to `unknown` by a persistence-only sweep. Issuance never sends.
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
  const failpoints = overrides.issuanceFailpoints;
  // V2 write-once, content-addressed store; also the storage readiness probe.
  // F5 (test only): a checkpoint before link() of a publication temp.
  const artifactStorage = new FilesystemContentAddressedArtifactStore(
    env.QUOTE_DOCUMENT_STORAGE_ROOT,
    failpoints
      ? {
          fs: {
            link: async (existing, target) => {
              await failpoints.reach("before_artifact_link", { detail: path.basename(String(existing)) });
              await fsPromises.link(existing, target);
            }
          }
        }
      : {}
  );
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
  const settings = issuanceSettings(env);
  const issuance = overrides.disableIssuanceExecution
    ? null
    : (() => {
        const repository = new PostgresIssuanceOperationRepository(database, { leaseMs: settings.leaseMs, deadlineMs: settings.deadlineMs, failpoints });
        return createIssuanceJobs({
          repository,
          attemptBody: createIssuanceAttemptBody({ repository, renderer: pdfRenderer, store: artifactStorage, logger: app.log, failpoints }),
          failpoints,
          leaseOwner: createWorkerInstanceId(env.SERVICE_NAME),
          settings,
          readiness: dependencyMonitor,
          lifecycle: lifecycleState,
          logger: app.log
        });
      })();
  const inlineIssuance = issuance
    ? new InlineIssuance({
        worker: issuance.worker,
        readiness: dependencyMonitor,
        isOperationActive: (operationId) => isOperationActive(database, operationId),
        syncBudgetMs: settings.syncBudgetMs,
        logger: app.log
      })
    : undefined;
  // Email delivery (Domain §10, R1.6B). `disabled` (default): no sender, so
  // new delivery requests answer `503 email_provider` and nothing is sent.
  // `gmail`: the Gmail adapter (validated configuration, bounded timeouts).
  // Issuance never sees the sender; only the delivery worker calls it.
  const delivery = deliverySettings(env);
  const mailSender: MailSenderPort | null =
    overrides.testMailSender ?? (env.QUOTE_EMAIL_PROVIDER === "gmail" ? new GmailMailSender(gmailSettings(env)) : null);
  const providerHealth = new ProviderHealthTracker(mailSender !== null);
  const deliveryJobs = overrides.disableDeliveryExecution
    ? null
    : (() => {
        const repository = new PostgresDeliveryRepository(database, { leaseMs: delivery.leaseMs, clock: overrides.quoteClock });
        const worker = mailSender
          ? new DeliveryWorker(
              {
                repository,
                sender: mailSender,
                documents: artifactStorage,
                renderHtml: renderEmailEnvelopeHtml,
                attachmentFileName: documentFileName,
                providerHealth,
                lifecycle: lifecycleState,
                logger: app.log,
                failpoints: overrides.deliveryFailpoints
              },
              {
                leaseOwner: createWorkerInstanceId(env.SERVICE_NAME),
                leaseMs: delivery.leaseMs,
                providerBudgetMs: delivery.tokenTimeoutMs + delivery.sendTimeoutMs,
                documentReadTimeoutMs: DELIVERY_DOCUMENT_READ_TIMEOUT_MS,
                completionMarginMs: DELIVERY_COMPLETION_MARGIN_MS,
                maxClaimsPerTick: 5
              }
            )
          : null;
        return createDeliveryJobs({
          repository,
          worker,
          pollIntervalMs: delivery.pollIntervalMs,
          readiness: dependencyMonitor,
          lifecycle: lifecycleState,
          logger: app.log
        });
      })();

  const backgroundJobs = new BackgroundJobManager({
    ...(issuance ? { issuance: issuance.issuance, issuanceDeadlineSweep: issuance.issuanceDeadlineSweep } : {}),
    ...(deliveryJobs ? { deliveryOutcomeSweep: deliveryJobs.deliveryOutcomeSweep } : {}),
    ...(deliveryJobs?.emailDelivery ? { emailDelivery: deliveryJobs.emailDelivery } : {})
  });

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
    // No new claims; an in-flight attempt (worker or inline) is aborted and
    // never marked succeeded: its lease expires and any process reclaims it.
    issuance?.worker.stop();
    // No new delivery claims or provider calls; an in-flight provider call
    // finishes under its own timeouts (never converted back to pending).
    deliveryJobs?.worker?.stop();
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
    // Health reports delivery execution: provider status from the worker's
    // outcomes (never probed), queue metrics from the database.
    emailProvider: () => providerHealth.view(),
    emailQueueMetrics: () => deliveryJobs?.queueMetrics() ?? null,
    startedAt: new Date(),
    businessRoutes: [
      v2QuoteRoutes(database, {
        clock: overrides.quoteClock,
        issuanceDeadlineMs: env.QUOTE_ISSUANCE_DEADLINE_MS,
        inlineIssuance,
        documents: artifactStorage,
        failpoints
      }),
      v2DeliveryRoutes(database, { clock: overrides.quoteClock, emailDeliveryEnabled: mailSender !== null }),
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
    issuance,
    delivery: deliveryJobs,
    mailSender,
    lifecycleState,
    dependencyMonitor,
    principalRegistry,
    shutdown
  };
}
