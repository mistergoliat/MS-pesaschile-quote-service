import crypto from "node:crypto";

import pg from "pg";

const { Client } = pg;

export interface TestDatabaseHandle {
  connectionString: string;
  databaseName: string;
  dispose(): Promise<void>;
}

export async function createTestDatabase(
  adminConnectionString: string
): Promise<TestDatabaseHandle> {
  const adminUrl = new URL(adminConnectionString);
  const databaseName = `quote_service_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminClient = new Client({
    connectionString: adminConnectionString
  });

  await adminClient.connect();

  try {
    await adminClient.query(`create database "${databaseName}"`);
  } finally {
    await adminClient.end();
  }

  const testDatabaseUrl = new URL(adminUrl.toString());
  testDatabaseUrl.pathname = `/${databaseName}`;

  return {
    connectionString: testDatabaseUrl.toString(),
    databaseName,
    async dispose() {
      const cleanupClient = new Client({
        connectionString: adminConnectionString
      });

      await cleanupClient.connect();

      try {
        await cleanupClient.query(
          `
            select pg_terminate_backend(pid)
            from pg_stat_activity
            where datname = $1
              and pid <> pg_backend_pid()
          `,
          [databaseName]
        );

        await cleanupClient.query(`drop database if exists "${databaseName}"`);
      } finally {
        await cleanupClient.end();
      }
    }
  };
}
