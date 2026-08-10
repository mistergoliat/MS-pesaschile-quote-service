import type { FastifyInstance } from "fastify";

import { HealthService } from "../../application/health/health-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";

export function registerHealthRoute(
  app: FastifyInstance,
  env: AppEnv,
  database: PostgresDatabase
): void {
  const healthService = new HealthService(database, {
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    databaseTimeoutMs: env.HEALTHCHECK_DATABASE_TIMEOUT_MS
  });

  app.get("/health", async (_request, reply) => {
    const result = await healthService.check(new Date());
    const statusCode = result.status === "ok" ? 200 : 503;

    return reply.code(statusCode).send(result);
  });
}
