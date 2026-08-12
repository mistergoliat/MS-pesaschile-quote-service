import Fastify, { type FastifyInstance } from "fastify";

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
import { PuppeteerPdfRenderer } from "./infrastructure/documents/puppeteer-pdf-renderer";
import { RealDocumentIssuanceAdapter } from "./infrastructure/documents/real-document-issuance";
import { GmailEmailSender } from "./infrastructure/email/gmail-email-sender";
import {
  createDefaultPesasChileSenderSignatureV1,
  createPesasChileBrandV1,
  QUOTE_EMAIL_TEMPLATE_VERSION
} from "./infrastructure/branding/pesaschile-brand-v1";
import { PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresQuoteDeliveryRepository } from "./infrastructure/persistence/postgres/quote-delivery-repository";
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
  quoteDeliveryService: QuoteDeliveryService;
  quoteEmailWorker: QuoteEmailWorker | null;
  clock: ClockPort;
  documentIssuancePort: DocumentIssuancePort;
  documentAccessService: QuoteDocumentAccessService;
  backgroundJobs: BackgroundJobManager;
  lifecycleState: ApplicationLifecycleState;
}

export interface BuildApplicationOverrides {
  readonly clock?: ClockPort;
  readonly documentIssuancePort?: DocumentIssuancePort;
  readonly emailSenderPort?: EmailSenderPort;
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
  const pdfRenderer = new PuppeteerPdfRenderer({
    timeoutMs: env.QUOTE_PDF_RENDER_TIMEOUT_MS,
    ...(env.QUOTE_PDF_EXECUTABLE_PATH
      ? { executablePath: env.QUOTE_PDF_EXECUTABLE_PATH }
      : {})
  });
  const realDocumentIssuanceAdapter = new RealDocumentIssuanceAdapter(artifactStorage, pdfRenderer, {
    renderVersion: env.QUOTE_RENDER_VERSION,
    emailTemplateVersion: QUOTE_EMAIL_TEMPLATE_VERSION,
    brandTheme,
    senderSignature: createDefaultPesasChileSenderSignatureV1()
  });
  const documentIssuancePort = overrides.documentIssuancePort ?? realDocumentIssuanceAdapter;
  const documentAccessService = new QuoteDocumentAccessService(
    artifactStorage,
    documentReferenceCodec
  );
  const lifecycleState = new ApplicationLifecycleState();
  const cleanupService = new OrphanDocumentCleanupService(artifactStorage, quoteService);
  const startupValidator = new StartupValidator(env, database, artifactStorage, pdfRenderer);
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
    quoteDeliveryService,
    clock,
    documentIssuancePort,
    documentAccessService
  );

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
    lifecycleState
  };
}
