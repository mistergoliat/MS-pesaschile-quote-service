import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { PostgresQuoteRepository } from "../../src/infrastructure/persistence/postgres/quote-repository";
import { QuoteService } from "../../src/application/quote/quote-service";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "./test-database";

export interface PostgresQuoteTestContext {
  readonly databaseHandle: TestDatabaseHandle;
  readonly database: PostgresDatabase;
  readonly repository: PostgresQuoteRepository;
  readonly service: QuoteService;
  readonly storageRoot: string;
  dispose(): Promise<void>;
}

export async function createPostgresQuoteTestContext(): Promise<PostgresQuoteTestContext> {
  const databaseHandle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-documents-pg-"));

  await runMigrations({
    databaseUrl: databaseHandle.connectionString,
    direction: "up"
  });

  const database = new PostgresDatabase({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: 0,
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseHandle.connectionString,
    DATABASE_SSL_MODE: "disable",
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-test",
    SERVICE_AUTH_TOKEN: "token",
    HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000,
    QUOTE_COMPANY_NAME: "Pesas Chile SPA",
    QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
    QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
    QUOTE_RENDER_VERSION: "quote-v1",
    QUOTE_PDF_RENDER_TIMEOUT_MS: 15000,
    ...(process.env.QUOTE_PDF_EXECUTABLE_PATH
      ? { QUOTE_PDF_EXECUTABLE_PATH: process.env.QUOTE_PDF_EXECUTABLE_PATH }
      : {})
  });

  const repository = new PostgresQuoteRepository(database);
  const service = new QuoteService(repository);

  return {
    databaseHandle,
    database,
    repository,
    service,
    storageRoot,
    async dispose() {
      await database.close();
      await databaseHandle.dispose();
      await fsPromises.rm(storageRoot, {
        recursive: true,
        force: true
      });
    }
  };
}

