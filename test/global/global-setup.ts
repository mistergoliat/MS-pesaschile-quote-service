import { spawnSync } from "node:child_process";
import path from "node:path";

import pg from "pg";

const { Client } = pg;

const repositoryRoot = path.resolve(process.cwd());
const adminDatabaseUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

function runDockerCompose(args: string[]): void {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const client = new Client({
      connectionString: adminDatabaseUrl
    });

    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
    }
  }

  throw new Error("PostgreSQL did not become ready within 30 seconds");
}

export default async function globalSetup() {
  runDockerCompose(["up", "-d", "postgres"]);
  await waitForPostgres();
  process.env.TEST_DATABASE_ADMIN_URL = adminDatabaseUrl;

  return () => {
    runDockerCompose(["down"]);
  };
}
