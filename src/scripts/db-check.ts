import "dotenv/config";

import { describeConfigError, loadMigrationEnv } from "../infrastructure/config/env";
import { PostgresDependencyProbe } from "../infrastructure/persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../infrastructure/persistence/postgres/schema-head";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Validates connectivity and schema head with the same logic as runtime
 * readiness. Exit 0 only when the schema is exactly at the expected head;
 * prints sanitized JSON (no DSN, host or credentials).
 */
async function main(): Promise<void> {
  const env = loadMigrationEnv();
  const manifest = loadMigrationManifest();
  const probe = new PostgresDependencyProbe({ connectionString: env.databaseUrl }, manifest);
  const result = await probe.probe(PROBE_TIMEOUT_MS);
  const ready = result.connection.ok && result.schema.state === "READY";

  console.log(
    JSON.stringify(
      {
        status: ready ? "ok" : "not_ready",
        database: result.connection.ok ? "ok" : result.connection.failureCategory,
        schema: {
          state: result.schema.state,
          expectedHead: manifest.expectedHead,
          actualHead: result.schema.actualHead
        }
      },
      null,
      2
    )
  );
  process.exitCode = ready ? 0 : 2;
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
