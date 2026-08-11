import type { FastifyInstance } from "fastify";

import type { ClockPort } from "../../application/ports/clock-port";
import type { DocumentIssuancePort } from "../../application/quote/ports/document-issuance-port";
import type { QuoteService } from "../../application/quote/quote-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { QuoteDocumentAccessService } from "../../infrastructure/documents/document-access-service";
import type { FilesystemDocumentArtifactStorage } from "../../infrastructure/documents/filesystem-document-artifact-storage";
import type { PuppeteerPdfRenderer } from "../../infrastructure/documents/puppeteer-pdf-renderer";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import type { ApplicationLifecycleState } from "../../infrastructure/runtime/application-lifecycle-state";
import { registerDocumentRoute } from "./document-route";
import { registerHealthRoute } from "./health-route";
import { registerQuoteRoute } from "./quote-route";

export function registerRoutes(
  app: FastifyInstance,
  env: AppEnv,
  database: PostgresDatabase,
  storage: FilesystemDocumentArtifactStorage,
  pdfRenderer: PuppeteerPdfRenderer,
  lifecycleState: ApplicationLifecycleState,
  quoteService: QuoteService,
  clock: ClockPort,
  documentIssuancePort: DocumentIssuancePort,
  documentAccessService: QuoteDocumentAccessService
): void {
  registerHealthRoute(app, env, database, storage, pdfRenderer, lifecycleState);
  registerQuoteRoute(app, env, quoteService, clock, documentIssuancePort, documentAccessService);
  registerDocumentRoute(app, env, quoteService, documentAccessService);
}
