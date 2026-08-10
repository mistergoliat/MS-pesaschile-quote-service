import type { FastifyInstance } from "fastify";

import { HealthService } from "../../application/health/health-service";
import { ReadinessService } from "../../application/health/readiness-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { FilesystemDocumentArtifactStorage } from "../../infrastructure/documents/filesystem-document-artifact-storage";
import type { PuppeteerPdfRenderer } from "../../infrastructure/documents/puppeteer-pdf-renderer";
import type { PostgresDatabase } from "../../infrastructure/persistence/postgres/postgres";
import type { ApplicationLifecycleState } from "../../infrastructure/runtime/application-lifecycle-state";

export function registerHealthRoute(
  app: FastifyInstance,
  env: AppEnv,
  database: PostgresDatabase,
  storage: FilesystemDocumentArtifactStorage,
  pdfRenderer: PuppeteerPdfRenderer,
  lifecycleState: ApplicationLifecycleState
): void {
  const healthService = new HealthService(database, {
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    databaseTimeoutMs: env.HEALTHCHECK_DATABASE_TIMEOUT_MS
  });
  const readinessService = new ReadinessService(database, storage, pdfRenderer, lifecycleState, {
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    databaseTimeoutMs: env.HEALTHCHECK_DATABASE_TIMEOUT_MS
  });

  app.get("/health", async (_request, reply) => {
    const result = await healthService.check(new Date());
    const statusCode = result.status === "ok" ? 200 : 503;

    return reply.code(statusCode).send(result);
  });

  app.get("/health/ready", async (_request, reply) => {
    const result = await readinessService.check(new Date());
    const statusCode = result.status === "ready" ? 200 : 503;

    return reply.code(statusCode).send(result);
  });
}
