import Fastify, { type FastifyInstance } from "fastify";

import type { ClockPort } from "./application/ports/clock-port";
import type { DocumentIssuancePort } from "./application/quote/ports/document-issuance-port";
import { QuoteService } from "./application/quote/quote-service";
import { DisabledDocumentIssuanceAdapter } from "./infrastructure/documents/disabled-document-issuance";
import type { AppEnv } from "./infrastructure/config/env";
import { PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { PostgresQuoteRepository } from "./infrastructure/persistence/postgres/quote-repository";
import { SystemClock } from "./infrastructure/time/system-clock";
import { registerRoutes } from "./http/routes";
import { sendErrorResponse } from "./http/errors";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
  quoteService: QuoteService;
  clock: ClockPort;
  documentIssuancePort: DocumentIssuancePort;
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
    logger: {
      level: env.LOG_LEVEL
    }
  });

  const database = new PostgresDatabase(env);
  const quoteRepository = new PostgresQuoteRepository(database);
  const quoteService = new QuoteService(quoteRepository);
  const clock = overrides.clock ?? new SystemClock();
  const documentIssuancePort =
    overrides.documentIssuancePort ?? new DisabledDocumentIssuanceAdapter();

  app.setErrorHandler((error, request, reply) => {
    return sendErrorResponse(error, request, reply);
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  registerRoutes(app, env, database, quoteService, clock, documentIssuancePort);

  return {
    app,
    database,
    quoteService,
    clock,
    documentIssuancePort
  };
}
