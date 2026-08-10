import Fastify, { type FastifyInstance } from "fastify";

import type { ClockPort } from "./application/ports/clock-port";
import type { DocumentIssuancePort } from "./application/quote/ports/document-issuance-port";
import { QuoteService } from "./application/quote/quote-service";
import type { AppEnv } from "./infrastructure/config/env";
import { QuoteDocumentAccessService } from "./infrastructure/documents/document-access-service";
import { DocumentReferenceCodec } from "./infrastructure/documents/document-reference";
import { FilesystemDocumentArtifactStorage } from "./infrastructure/documents/filesystem-document-artifact-storage";
import { OrphanDocumentCleanupService } from "./infrastructure/documents/orphan-document-cleanup-service";
import { PuppeteerPdfRenderer } from "./infrastructure/documents/puppeteer-pdf-renderer";
import { RealDocumentIssuanceAdapter } from "./infrastructure/documents/real-document-issuance";
import { PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresQuoteRepository } from "./infrastructure/persistence/postgres/quote-repository";
import { ApplicationLifecycleState } from "./infrastructure/runtime/application-lifecycle-state";
import { BackgroundJobManager } from "./infrastructure/runtime/background-job-manager";
import { StartupValidator } from "./infrastructure/runtime/startup-validator";
import { SystemClock } from "./infrastructure/time/system-clock";
import { sendErrorResponse } from "./http/errors";
import { registerRoutes } from "./http/routes";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
  quoteService: QuoteService;
  clock: ClockPort;
  documentIssuancePort: DocumentIssuancePort;
  documentAccessService: QuoteDocumentAccessService;
  backgroundJobs: BackgroundJobManager;
  lifecycleState: ApplicationLifecycleState;
}

export interface BuildApplicationOverrides {
  readonly clock?: ClockPort;
  readonly documentIssuancePort?: DocumentIssuancePort;
}

export function buildApplication(
  env: AppEnv,
  overrides: BuildApplicationOverrides = {}
): ApplicationContext {
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
  const quoteService = new QuoteService(quoteRepository);
  const clock = overrides.clock ?? new SystemClock();
  const artifactStorage = new FilesystemDocumentArtifactStorage(env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const documentReferenceCodec = new DocumentReferenceCodec(env.QUOTE_DOCUMENT_REF_SECRET);
  const pdfRenderer = new PuppeteerPdfRenderer({
    timeoutMs: env.QUOTE_PDF_RENDER_TIMEOUT_MS,
    ...(env.QUOTE_PDF_EXECUTABLE_PATH
      ? { executablePath: env.QUOTE_PDF_EXECUTABLE_PATH }
      : {})
  });
  const realDocumentIssuanceAdapter = new RealDocumentIssuanceAdapter(artifactStorage, pdfRenderer, {
    companyName: env.QUOTE_COMPANY_NAME,
    renderVersion: env.QUOTE_RENDER_VERSION
  });
  const documentIssuancePort = overrides.documentIssuancePort ?? realDocumentIssuanceAdapter;
  const documentAccessService = new QuoteDocumentAccessService(
    artifactStorage,
    documentReferenceCodec
  );
  const lifecycleState = new ApplicationLifecycleState();
  const cleanupService = new OrphanDocumentCleanupService(artifactStorage, quoteService);
  const startupValidator = new StartupValidator(env, database, artifactStorage, pdfRenderer);
  const backgroundJobs = new BackgroundJobManager({
    env,
    clock,
    quoteService,
    cleanupService,
    database,
    logger: app.log
  });

  app.setErrorHandler((error, request, reply) => {
    return sendErrorResponse(error, request, reply);
  });

  app.addHook("onReady", async () => {
    app.log.info({ service: env.SERVICE_NAME }, "Running startup validation");
    await startupValidator.validate();
    app.log.info({ service: env.SERVICE_NAME }, "Startup validation completed");
  });

  app.addHook("onListen", () => {
    backgroundJobs.start();
    app.log.info({ service: env.SERVICE_NAME }, "Background jobs started");
  });

  app.addHook("onClose", async () => {
    lifecycleState.markShuttingDown();
    await backgroundJobs.stop();
    await database.close();

    if ("close" in pdfRenderer && typeof pdfRenderer.close === "function") {
      await pdfRenderer.close();
    }
  });

  registerRoutes(
    app,
    env,
    database,
    artifactStorage,
    pdfRenderer,
    lifecycleState,
    quoteService,
    clock,
    documentIssuancePort,
    documentAccessService
  );

  return {
    app,
    database,
    quoteService,
    clock,
    documentIssuancePort,
    documentAccessService,
    backgroundJobs,
    lifecycleState
  };
}
