import type { FastifyInstance } from "fastify";

import type { DependencyMonitor } from "../../application/health/dependency-monitor";
import type { ClockPort } from "../../application/ports/clock-port";
import type { QuoteDeliveryService } from "../../application/quote-delivery/quote-delivery-service";
import type { DocumentIssuancePort } from "../../application/quote/ports/document-issuance-port";
import type { QuoteService } from "../../application/quote/quote-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { QuoteDocumentAccessService } from "../../infrastructure/documents/document-access-service";
import type { BackgroundJobManager } from "../../infrastructure/runtime/background-job-manager";
import { createReadinessGate } from "../readiness-gate";
import { registerDocumentRoute } from "./document-route";
import { registerHealthRoute } from "./health-route";
import { registerQuoteRoute } from "./quote-route";

export interface RegisterRoutesInput {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly backgroundJobs: BackgroundJobManager;
  readonly emailEnabled: boolean;
  readonly startedAt: Date;
  readonly quoteService: QuoteService;
  readonly quoteDeliveryService: QuoteDeliveryService;
  readonly clock: ClockPort;
  readonly documentIssuancePort: DocumentIssuancePort;
  readonly documentAccessService: QuoteDocumentAccessService;
}

export function registerRoutes(app: FastifyInstance, input: RegisterRoutesInput): void {
  registerHealthRoute(app, input);

  // Every business route inherits the readiness gate from this context.
  app.register((businessApp, _options, done) => {
    businessApp.addHook("onRequest", createReadinessGate(input.monitor));
    registerQuoteRoute(
      businessApp,
      input.env,
      input.quoteService,
      input.quoteDeliveryService,
      input.clock,
      input.documentIssuancePort,
      input.documentAccessService
    );
    registerDocumentRoute(businessApp, input.env, input.quoteService, input.documentAccessService);
    done();
  });
}
