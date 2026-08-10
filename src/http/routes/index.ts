import type { FastifyInstance } from "fastify";

import type { ClockPort } from "../../application/ports/clock-port";
import type { DocumentIssuancePort } from "../../application/quote/ports/document-issuance-port";
import type { QuoteService } from "../../application/quote/quote-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { registerHealthRoute } from "./health-route";
import { registerQuoteRoute } from "./quote-route";

export function registerRoutes(
  app: FastifyInstance,
  env: AppEnv,
  database: PostgresDatabase,
  quoteService: QuoteService,
  clock: ClockPort,
  documentIssuancePort: DocumentIssuancePort
): void {
  registerHealthRoute(app, env, database);
  registerQuoteRoute(app, env, quoteService, clock, documentIssuancePort);
}
