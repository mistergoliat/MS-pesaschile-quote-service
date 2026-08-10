import path from "node:path";

import { runner } from "node-pg-migrate";

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
    dir: path.resolve(__dirname, "migrations"),
    direction,
    migrationsTable: "schema_migrations",
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
