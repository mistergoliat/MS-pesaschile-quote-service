import "dotenv/config";

import { describeConfigError, loadMigrationEnv } from "../infrastructure/config/env";
import { runMigrations } from "../infrastructure/persistence/postgres/migrator";
import { migrationErrorSummary } from "../infrastructure/persistence/postgres/migration-error-summary";

// Explicit, operator-run DDL path. The server never runs migrations.
// Uses MIGRATION_DATABASE_URL when set, otherwise DATABASE_URL.
async function main(): Promise<void> {
  const directionArg = process.argv[2];

  if (directionArg !== "up" && directionArg !== "down") {
    throw new Error("Usage: npm run db:migrate -- <up|down>");
  }

  const env = loadMigrationEnv();
  await runMigrations({
    databaseUrl: env.databaseUrl,
    connectionConfig: env.connectionConfig,
    direction: directionArg
  });
  console.log(JSON.stringify({ status: "ok", direction: directionArg }));
}

main().catch((error: unknown) => {
  const configError = describeConfigError(error);
  console.error(
    JSON.stringify(
      configError
        ? { status: "config_invalid", ...configError }
        : {
            status: "failed",
            tool: "db:migrate",
            phase: "migration",
            ...migrationErrorSummary(error)
          }
    )
  );
  process.exit(1);
});
