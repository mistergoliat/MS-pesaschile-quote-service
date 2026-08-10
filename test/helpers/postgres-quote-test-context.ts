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
  dispose(): Promise<void>;
}

export async function createPostgresQuoteTestContext(): Promise<PostgresQuoteTestContext> {
  const databaseHandle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);

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
    HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000
  });

  const repository = new PostgresQuoteRepository(database);
  const service = new QuoteService(repository);

  return {
    databaseHandle,
    database,
    repository,
    service,
    async dispose() {
      await database.close();
      await databaseHandle.dispose();
    }
  };
}

