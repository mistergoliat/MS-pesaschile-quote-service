import "dotenv/config";

import { describeConfigError, loadMigrationEnv } from "../infrastructure/config/env";
import { applyRuntimeGrants } from "../infrastructure/persistence/postgres/migrator";

// Re-applies the quote_runtime grants after the role was provisioned.
// Runs with MIGRATION_DATABASE_URL (or DATABASE_URL) as the object owner.
async function main(): Promise<void> {
  const env = loadMigrationEnv();
  const result = await applyRuntimeGrants(env.databaseUrl);

  console.log(JSON.stringify({ status: result.runtimeRolePresent ? "ok" : "skipped_role_missing" }));
  process.exitCode = result.runtimeRolePresent ? 0 : 2;
}

main().catch((error: unknown) => {
  const configError = describeConfigError(error);
  console.error(
    JSON.stringify(
      configError
        ? { status: "config_invalid", ...configError }
        : { status: "failed", errorName: error instanceof Error ? error.name : "unknown" }
    )
  );
  process.exit(1);
});
