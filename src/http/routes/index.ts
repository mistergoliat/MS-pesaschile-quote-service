import type { FastifyInstance, onRequestHookHandler } from "fastify";

import type { DependencyMonitor } from "../../application/health/dependency-monitor";
import type { PrincipalRegistry } from "../../infrastructure/auth/principal-registry";
import type { AppEnv } from "../../infrastructure/config/env";
import type { BackgroundJobManager } from "../../infrastructure/runtime/background-job-manager";
import { enforceRouteScopes } from "../authentication";
import { HttpError } from "../errors";
import { enforceRouteCapabilities } from "../readiness-gate";
import { registerHealthRoute, type HealthRouteDependencies } from "./health-route";

/**
 * Registers business routes inside the capability-gated, scope-enforced
 * context. Every route must set `config.requiredScope` and `config.capability`.
 */
export type BusinessRouteRegistrar = (businessApp: FastifyInstance) => void;

export interface RegisterRoutesInput extends HealthRouteDependencies {
  readonly env: AppEnv;
  readonly monitor: DependencyMonitor;
  readonly principalRegistry: PrincipalRegistry;
  readonly backgroundJobs: BackgroundJobManager;
  readonly startedAt: Date;
  readonly businessRoutes: readonly BusinessRouteRegistrar[];
}

/**
 * Domain §12 `api_version_retired`: every `/v1` path, any method. Answered in
 * `onRequest`, before body parsing, authentication or any dependency gate:
 * the contract requires no credential to learn that a version is retired,
 * and the answer does not depend on the body or on dependency state.
 */
const retireV1: onRequestHookHandler = (_request, _reply, done) => {
  done(new HttpError({ statusCode: 410, code: "api_version_retired", message: "API version 1 is retired; use /v2." }));
};

export function registerRoutes(app: FastifyInstance, input: RegisterRoutesInput): void {
  registerHealthRoute(app, input);

  // `/v1/*` also matches `/v1/`; `/v10`, `/v1x` and `/v2` never match.
  for (const url of ["/v1", "/v1/*"]) {
    app.all(url, { onRequest: retireV1 }, () => {
      throw new Error("unreachable: retired in onRequest");
    });
  }

  app.register((businessApp, _options, done) => {
    // Scope first, so a route missing both reports the scope (existing contract of this check).
    enforceRouteScopes(businessApp, input.principalRegistry);
    enforceRouteCapabilities(businessApp, input.monitor);

    // A route without a declared scope or capability throws here; report it
    // so startup fails immediately instead of waiting for the plugin timeout.
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
