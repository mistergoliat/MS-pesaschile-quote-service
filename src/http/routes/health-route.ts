import type { FastifyInstance } from "fastify";

import type {
  DependencyMonitor,
  DependencyStatusView
} from "../../application/health/dependency-monitor";
import type { DeliveryQueueMetrics } from "../../application/quote-v2/delivery/delivery-execution";
import type { PrincipalRegistry } from "../../infrastructure/auth/principal-registry";
import type { AppEnv } from "../../infrastructure/config/env";
import type {
  BackgroundJobManager,
  BackgroundJobStatus
} from "../../infrastructure/runtime/background-job-manager";
import { requireScope } from "../authentication";

export interface HealthRouteDependencies {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly principalRegistry: PrincipalRegistry;
  readonly backgroundJobs: BackgroundJobManager;
  /** `emailProvider` status, derived from configuration and the delivery worker's outcomes; never a provider probe. */
  readonly emailProvider: () => EmailProviderView;
  /** Last measured `emailDelivery` queue metrics (database), or null before the first measurement. */
  readonly emailQueueMetrics: () => DeliveryQueueMetrics | null;
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

// Issuance and expiry queue metrics are still not measured (R1.6D); the
// frozen contract requires the fields, so they report an empty queue.
// emailDelivery reports the due `pending` deliveries measured by the
// persistence sweep (R1.6B).
function toWorkerView(job: BackgroundJobStatus, metrics: DeliveryQueueMetrics | null = null): WorkerStatusView {
  return {
    enabled: job.enabled,
    lastPollAt: job.lastPollAt,
    queueDepth: metrics?.queueDepth ?? 0,
    oldestPendingAgeSeconds: metrics?.oldestPendingAgeSeconds ?? null
  };
}

/**
 * Liveness, readiness and dependency detail. None of these handlers probes a
 * dependency: they read the DependencyMonitor's cached state, so they answer
 * fast and cannot fan out load onto a struggling database.
 */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDependencies): void {
  const { env, monitor, principalRegistry, backgroundJobs, emailProvider, emailQueueMetrics, startedAt } = deps;

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

  app.get(
    "/health/dependencies",
    { preHandler: requireScope(principalRegistry, "service:health:dependencies") },
    async (_request, reply) => {
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
          // Never a provider call; email never affects readiness.
          emailProvider: emailProvider()
        },
        workers: {
          issuance: toWorkerView(jobs.issuance),
          expiry: toWorkerView(jobs.expiry),
          emailDelivery: toWorkerView(jobs.emailDelivery, emailQueueMetrics())
        }
      });
    }
  );
}
