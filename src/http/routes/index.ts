import type { FastifyInstance } from "fastify";

import type { DependencyMonitor } from "../../application/health/dependency-monitor";
import type { PrincipalRegistry } from "../../infrastructure/auth/principal-registry";
import type { AppEnv } from "../../infrastructure/config/env";
import type { BackgroundJobManager } from "../../infrastructure/runtime/background-job-manager";
import { enforceRouteScopes } from "../authentication";
import { createReadinessGate } from "../readiness-gate";
import { registerHealthRoute, type HealthRouteDependencies } from "./health-route";

/** Registers business routes inside the readiness-gated, scope-enforced context. Every route must set `config.requiredScope`. */
export type BusinessRouteRegistrar = (businessApp: FastifyInstance) => void;

export interface RegisterRoutesInput extends HealthRouteDependencies {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly principalRegistry: PrincipalRegistry;
  readonly backgroundJobs: BackgroundJobManager;
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
    enforceRouteScopes(businessApp, input.principalRegistry);

    // A route without a declared scope throws here; report it so startup
    // fails immediately instead of waiting for the plugin timeout.
    try {
      for (const register of input.businessRoutes) {
        register(businessApp);
      }
    } catch (error) {
      done(error as Error);
      return;
    }

    done();
  });
}
