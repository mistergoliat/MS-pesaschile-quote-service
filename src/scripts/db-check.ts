import "dotenv/config";

import { loadEnv } from "../infrastructure/config/env";
import { PostgresDatabase } from "../infrastructure/persistence/postgres/postgres";

async function main(): Promise<void> {
  const env = loadEnv();
  const database = new PostgresDatabase(env);

  try {
    const result = await database.query<{ now: string }>("select now()::text as now");

    console.log(
      JSON.stringify(
        {
          status: "ok",
          now: result.rows[0]?.now ?? null
        },
        null,
        2
      )
    );
  } finally {
    await database.close();
  }
}

void main();
