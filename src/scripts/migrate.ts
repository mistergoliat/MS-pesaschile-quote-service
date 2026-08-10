import "dotenv/config";

import { loadEnv } from "../infrastructure/config/env";
import { runMigrations } from "../infrastructure/persistence/postgres/migrator";

async function main(): Promise<void> {
  const directionArg = process.argv[2];

  if (directionArg !== "up" && directionArg !== "down") {
    throw new Error("Usage: npm run db:migrate -- <up|down>");
  }

  const env = loadEnv();
  await runMigrations({
    databaseUrl: env.DATABASE_URL,
    direction: directionArg
  });
}

void main();
