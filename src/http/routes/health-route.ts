import type { FastifyInstance } from "fastify";

import type {
  DependencyMonitor,
  DependencyStatusView
} from "../../application/health/dependency-monitor";
import type { AppEnv } from "../../infrastructure/config/env";
import type {
  BackgroundJobManager,
  BackgroundJobStatus
} from "../../infrastructure/runtime/background-job-manager";
import { assertServiceAuthentication } from "../service-auth";

export interface HealthRouteDependencies {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly backgroundJobs: BackgroundJobManager;
  readonly emailEnabled: boolean;
  readonly startedAt: Date;
}

interface WorkerStatusView {
  readonly enabled: boolean;
  readonly lastPollAt: string | null;
  readonly queueDepth: number;
  readonly oldestPendingAgeSeconds: number | null;
}

interface EmailProviderView {
  readonly status: DependencyStatusView["status"] | "disabled";
  readonly failureCategory: DependencyStatusView["failureCategory"];
  readonly lastSuccessAt: string | null;
}

// Queue metrics are not measured before the V2 workers (R1.5); the frozen
// contract requires the fields, so they report an empty queue.
function toWorkerView(job: BackgroundJobStatus): WorkerStatusView {
  return {
    enabled: job.enabled,
    lastPollAt: job.lastPollAt,
    queueDepth: 0,
    oldestPendingAgeSeconds: null
  };
}

// The provider is never called by a health check. Its status is derived from
// the delivery worker's last iteration; email never affects readiness.
function toEmailProviderView(emailEnabled: boolean, job: BackgroundJobStatus): EmailProviderView {
  if (!emailEnabled) {
    return {
      status: "disabled",
      failureCategory: null,
      lastSuccessAt: null
    };
  }

  return {
    status: job.lastSuccessAt !== null && !job.lastIterationFailed ? "up" : "degraded",
    failureCategory: job.lastIterationFailed ? "provider_error" : null,
    lastSuccessAt: job.lastSuccessAt
  };
}

/**
 * Liveness, readiness and dependency detail. None of these handlers probes a
 * dependency: they read the DependencyMonitor's cached state, so they answer
 * fast and cannot fan out load onto a struggling database.
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDependencies): void {
  const { env, monitor, backgroundJobs, emailEnabled, startedAt } = deps;

  app.get("/health/live", async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").code(200).send({ status: "live" });
  });

  // Deprecated V1 alias kept for existing probes: liveness semantics, no dependency check.
  app.get("/health", async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").code(200).send({
      status: "ok",
      service: env.SERVICE_NAME,
      version: env.SERVICE_VERSION
    });
  });

  app.get("/health/ready", async (_request, reply) => {
    const readiness = monitor.readiness();

    return reply
      .header("Cache-Control", "no-store")
      .code(readiness.status === "ready" ? 200 : 503)
      .send(readiness);
  });

  app.get("/health/dependencies", async (request, reply) => {
    assertServiceAuthentication(request.headers.authorization, env.SERVICE_AUTH_TOKEN);

    const details = monitor.details();
    const jobs = backgroundJobs.status();

    return reply.header("Cache-Control", "no-store").code(200).send({
      service: {
        name: env.SERVICE_NAME,
        version: env.SERVICE_VERSION,
        startedAt: startedAt.toISOString()
      },
      schema: {
        expectedHead: details.schema.expectedHead,
        actualHead: details.schema.actualHead
      },
      dependencies: {
        ...details.dependencies,
        emailProvider: toEmailProviderView(emailEnabled, jobs.emailDelivery)
      },
      workers: {
        issuance: toWorkerView(jobs.issuance),
        expiry: toWorkerView(jobs.expiry),
        emailDelivery: toWorkerView(jobs.emailDelivery)
      }
    });
  });
}
