import path from "node:path";

import { runner } from "node-pg-migrate";

export const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "migrations");
export const MIGRATIONS_TABLE = "schema_migrations";

export interface RunMigrationsInput {
  databaseUrl: string;
  direction: "up" | "down";
}

export async function runMigrations({
  databaseUrl,
  direction
}: RunMigrationsInput): Promise<void> {
  const options = {
    databaseUrl,
    dir: MIGRATIONS_DIRECTORY,
    direction,
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    noLock: false,
    log: () => undefined
  } as const;

  await runner(
    direction === "down"
      ? {
          ...options,
          count: 1
        }
      : options
  );
}
