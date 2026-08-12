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
  }, 30_000);

  afterAll(async () => {
    await testDatabase.dispose();
  }, 30_000);

  it("applies the baseline and quote persistence migrations", async () => {
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
      const quotesTableResult = await client.query<{ table_name: string }>(
        `
          select table_name
          from information_schema.tables
          where table_schema = 'quote_service'
            and table_name in (
              'quotes',
              'quote_lines',
              'idempotency_keys',
              'quote_audit_events',
              'quote_deliveries',
              'quote_email_outbox'
            )
          order by table_name asc
        `
      );
      const sequenceResult = await client.query<{ sequence_name: string }>(
        `
          select sequence_name
          from information_schema.sequences
          where sequence_schema = 'quote_service'
            and sequence_name = 'quote_number_seq'
        `
      );

      expect(schemaResult.rowCount).toBe(1);
      expect(extensionResult.rowCount).toBe(1);
      expect(quotesTableResult.rows.map((row) => row.table_name)).toEqual([
        "idempotency_keys",
        "quote_audit_events",
        "quote_deliveries",
        "quote_email_outbox",
        "quote_lines",
        "quotes"
      ]);
      expect(sequenceResult.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("rolls back only the latest delivery migration on a disposable database", async () => {
    await runMigrations({
      databaseUrl: testDatabase.connectionString,
      direction: "up"
    });
    await runMigrations({
      databaseUrl: testDatabase.connectionString,
      direction: "down"
    });

    const client = new Client({
      connectionString: testDatabase.connectionString
    });

    await client.connect();

    try {
      const tableResult = await client.query<{ table_name: string }>(
        `
          select table_name
          from information_schema.tables
          where table_schema = 'quote_service'
            and table_name in (
              'quotes',
              'quote_lines',
              'idempotency_keys',
              'quote_audit_events',
              'quote_deliveries',
              'quote_email_outbox'
            )
        `
      );
      const sequenceResult = await client.query<{ sequence_name: string }>(
        `
          select sequence_name
          from information_schema.sequences
          where sequence_schema = 'quote_service'
            and sequence_name = 'quote_number_seq'
        `
      );
      const schemaResult = await client.query<{ schema_name: string }>(
        "select schema_name from information_schema.schemata where schema_name = 'quote_service'"
      );

      expect(tableResult.rows.map((row) => row.table_name).sort()).toEqual([
        "idempotency_keys",
        "quote_audit_events",
        "quote_lines",
        "quotes"
      ]);
      expect(sequenceResult.rowCount).toBe(1);
      expect(schemaResult.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});
