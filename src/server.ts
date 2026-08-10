import "dotenv/config";

import { buildApplication } from "./app";
import { loadEnv } from "./infrastructure/config/env";

async function main(): Promise<void> {
  const env = loadEnv();
  const { app } = buildApplication(env);

  await app.listen({
    host: env.HOST,
    port: env.PORT
  });
}

void main();
