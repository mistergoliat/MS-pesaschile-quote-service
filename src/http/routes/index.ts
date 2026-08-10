import type { FastifyInstance } from "fastify";

import type { AppEnv } from "../../infrastructure/config/env";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import { registerHealthRoute } from "./health-route";

export function registerRoutes(
  app: FastifyInstance,
  env: AppEnv,
  database: PostgresDatabase
): void {
  registerHealthRoute(app, env, database);
}
