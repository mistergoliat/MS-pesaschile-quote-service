import Fastify, { type FastifyInstance } from "fastify";

import { DependencyMonitor } from "./application/health/dependency-monitor";
import type { ClockPort } from "./application/ports/clock-port";
import type { EmailSenderPort } from "./application/quote-delivery/ports/email-sender-port";
import { QuoteDeliveryService } from "./application/quote-delivery/quote-delivery-service";
import { QuoteEmailWorker } from "./application/quote-delivery/quote-email-worker";
import type { DocumentIssuancePort } from "./application/quote/ports/document-issuance-port";
import { QuoteService } from "./application/quote/quote-service";
import type { AppEnv } from "./infrastructure/config/env";
import { QuoteDocumentAccessService } from "./infrastructure/documents/document-access-service";
import { DocumentReferenceCodec } from "./infrastructure/documents/document-reference";
import { FilesystemDocumentArtifactStorage } from "./infrastructure/documents/filesystem-document-artifact-storage";
import { OrphanDocumentCleanupService } from "./infrastructure/documents/orphan-document-cleanup-service";
import { NativePdfRenderer, type PdfRendererPort } from "./infrastructure/documents/native-pdf-renderer";
import { RealDocumentIssuanceAdapter } from "./infrastructure/documents/real-document-issuance";
import { GmailEmailSender } from "./infrastructure/email/gmail-email-sender";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "./infrastructure/branding/pesaschile-brand-v1";
import { buildConnectionConfig, PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresDependencyProbe } from "./infrastructure/persistence/postgres/postgres-dependency-probe";
import { PostgresQuoteDeliveryRepository } from "./infrastructure/persistence/postgres/quote-delivery-repository";
import { PostgresQuoteRepository } from "./infrastructure/persistence/postgres/quote-repository";
import { loadMigrationManifest } from "./infrastructure/persistence/postgres/schema-head";
import { ApplicationLifecycleState } from "./infrastructure/runtime/application-lifecycle-state";
import { BackgroundJobManager } from "./infrastructure/runtime/background-job-manager";
import { SystemClock } from "./infrastructure/time/system-clock";
import { sendErrorResponse, toHttpError } from "./http/errors";
import { registerRoutes } from "./http/routes";

export type ShutdownOutcome = "completed" | "timed_out" | "failed";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
  quoteService: QuoteService;
  quoteDeliveryService: QuoteDeliveryService;
  quoteEmailWorker: QuoteEmailWorker | null;
  clock: ClockPort;
  documentIssuancePort: DocumentIssuancePort;
  documentAccessService: QuoteDocumentAccessService;
  backgroundJobs: BackgroundJobManager;
  lifecycleState: ApplicationLifecycleState;
  dependencyMonitor: DependencyMonitor;
  /**
   * Ordered, bounded shutdown: not-ready → stop probes and jobs → close HTTP
   * (drains in-flight requests) → close the database pool. Resolves within
   * APP_SHUTDOWN_TIMEOUT_MS; idempotent.
   */
  shutdown(reason: string): Promise<ShutdownOutcome>;
}

export interface BuildApplicationOverrides {
  readonly clock?: ClockPort;
  readonly documentIssuancePort?: DocumentIssuancePort;
  readonly emailSenderPort?: EmailSenderPort;
  readonly pdfRenderer?: PdfRendererPort;
}

/**
 * Builds the application without touching any external dependency. Throws
 * only for local initialization corruption (e.g. an inconsistent packaged
 * migration set); dependency availability is the DependencyMonitor's concern.
 */
export function buildApplication(
  env: AppEnv,
  overrides: BuildApplicationOverrides = {}
): ApplicationContext {
  const migrationManifest = loadMigrationManifest();
  const app: FastifyInstance = Fastify({
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    requestTimeout: env.HTTP_REQUEST_TIMEOUT_MS,
    connectionTimeout: env.HTTP_CONNECTION_TIMEOUT_MS,
    keepAliveTimeout: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    logger: {
      level: env.LOG_LEVEL
    },
    routerOptions: {
      maxParamLength: 1024
    }
  });

  const database = new PostgresDatabase(env);
  const quoteRepository = new PostgresQuoteRepository(database);
  const quoteDeliveryRepository = new PostgresQuoteDeliveryRepository(database);
  const quoteService = new QuoteService(quoteRepository);
  const quoteDeliveryService = new QuoteDeliveryService(
    quoteDeliveryRepository,
    env.QUOTE_EMAIL_PROVIDER !== "disabled"
  );
  const clock = overrides.clock ?? new SystemClock();
  const brandTheme = createPesasChileBrandV1({
    legalName: env.QUOTE_COMPANY_NAME
  });
  const artifactStorage = new FilesystemDocumentArtifactStorage(env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const documentReferenceCodec = new DocumentReferenceCodec(env.QUOTE_DOCUMENT_REF_SECRET);
  const senderSignature = createDefaultPesasChileSenderSignatureV1();
  const pdfRenderer =
    overrides.pdfRenderer ??
    new NativePdfRenderer({
      renderVersion: env.QUOTE_RENDER_VERSION,
      brand: brandTheme,
      senderSignature
    });
  const realDocumentIssuanceAdapter = new RealDocumentIssuanceAdapter(artifactStorage, pdfRenderer, {
    renderVersion: env.QUOTE_RENDER_VERSION,
    emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
    brandTheme,
    senderSignature
  });
  const documentIssuancePort = overrides.documentIssuancePort ?? realDocumentIssuanceAdapter;
  const documentAccessService = new QuoteDocumentAccessService(
    artifactStorage,
    documentReferenceCodec
  );
  const lifecycleState = new ApplicationLifecycleState();
  const dependencyMonitor = new DependencyMonitor(
    {
      database: new PostgresDependencyProbe(buildConnectionConfig(env), migrationManifest.names),
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
  const cleanupService = new OrphanDocumentCleanupService(artifactStorage, quoteService);
  const emailSenderPort =
    overrides.emailSenderPort ??
    (env.QUOTE_EMAIL_PROVIDER === "gmail"
      ? new GmailEmailSender({
          clientId: env.GOOGLE_GMAIL_CLIENT_ID!,
          clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET!,
          refreshToken: env.GOOGLE_GMAIL_REFRESH_TOKEN!,
          user: env.GOOGLE_GMAIL_USER!
        })
      : undefined);
  const quoteEmailWorker =
    emailSenderPort && env.QUOTE_EMAIL_PROVIDER !== "disabled"
      ? new QuoteEmailWorker(
          quoteDeliveryRepository,
          artifactStorage,
          emailSenderPort,
          {
            address: env.QUOTE_EMAIL_FROM_ADDRESS!,
            name: env.QUOTE_EMAIL_FROM_NAME!
          },
          env.QUOTE_EMAIL_REPLY_TO ?? null,
          env.QUOTE_EMAIL_DELIVERY_MAX_ATTEMPTS
        )
      : null;
  const backgroundJobs = new BackgroundJobManager({
    env,
    clock,
    quoteService,
    quoteEmailWorker,
    cleanupService,
    database,
    logger: app.log,
    canRun: () => dependencyMonitor.isReady()
  });

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
    backgroundJobs,
    emailEnabled: quoteEmailWorker !== null,
    startedAt: new Date(),
    quoteService,
    quoteDeliveryService,
    clock,
    documentIssuancePort,
    documentAccessService
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
    quoteService,
    quoteDeliveryService,
    quoteEmailWorker,
    clock,
    documentIssuancePort,
    documentAccessService,
    backgroundJobs,
    lifecycleState,
    dependencyMonitor,
    shutdown
  };
}
