// R1.6D synthetic V1 -> V2 migration rehearsal (see
// test/integration/migration-rehearsal.integration.test.ts). Runs the
// rehearsal against disposable local databases (the test PostgreSQL from
// docker-compose.yml, started and stopped by the test global setup) and
// writes the committed report. Never point TEST_DATABASE_ADMIN_URL at a
// production or shared server.
import { spawnSync } from "node:child_process";
import path from "node:path";

const report = process.argv[2] ?? "docs/R1.6D_SYNTHETIC_MIGRATION_REHEARSAL.md";
const result = spawnSync(
  process.execPath,
  [path.resolve("node_modules/vitest/vitest.mjs"), "run", "test/integration/migration-rehearsal.integration.test.ts"],
  { stdio: "inherit", env: { ...process.env, QUOTE_MIGRATION_REHEARSAL_REPORT: report } }
);

process.exit(result.status ?? 1);
