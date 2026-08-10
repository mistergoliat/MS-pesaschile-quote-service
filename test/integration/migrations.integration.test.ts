import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "../helpers/test-database";

const { Client } = pg;

describe("database migrations", () => {
  let testDatabase: TestDatabaseHandle;

  beforeAll(async () => {
    testDatabase = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  });

  afterAll(async () => {
    await testDatabase.dispose();
  });

  it("applies the baseline migration", async () => {
    await runMigrations({
      databaseUrl: testDatabase.connectionString,
      direction: "up"
    });

    const client = new Client({
      connectionString: testDatabase.connectionString
    });

    await client.connect();

    try {
      const schemaResult = await client.query<{ schema_name: string }>(
        "select schema_name from information_schema.schemata where schema_name = 'quote_service'"
      );
      const extensionResult = await client.query<{ extname: string }>(
        "select extname from pg_extension where extname = 'pgcrypto'"
      );

      expect(schemaResult.rowCount).toBe(1);
      expect(extensionResult.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});
