import type { FastifyInstance } from "fastify";

import type { DependencyMonitor } from "../../application/health/dependency-monitor";
import type { AppEnv } from "../../infrastructure/config/env";
import type { BackgroundJobManager } from "../../infrastructure/runtime/background-job-manager";
import { createReadinessGate } from "../readiness-gate";
import { registerHealthRoute } from "./health-route";

/** Registers business routes inside the readiness-gated context. */
export type BusinessRouteRegistrar = (businessApp: FastifyInstance) => void;

export interface RegisterRoutesInput {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly backgroundJobs: BackgroundJobManager;
  readonly emailEnabled: boolean;
  readonly startedAt: Date;
  readonly businessRoutes: readonly BusinessRouteRegistrar[];
}

export function registerRoutes(app: FastifyInstance, input: RegisterRoutesInput): void {
  registerHealthRoute(app, input);

  // Every business route inherits the readiness gate from this context. The
  // V1 routes were retired in R1.4 (their persistence no longer exists); the
  // V2 routes (R1.5) register here.
  app.register((businessApp, _options, done) => {
    businessApp.addHook("onRequest", createReadinessGate(input.monitor));

    for (const register of input.businessRoutes) {
      register(businessApp);
    }

    done();
  });
}
