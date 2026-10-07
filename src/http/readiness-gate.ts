import type { FastifyInstance } from "fastify";

import type { Capability, DependencyMonitor } from "../application/health/dependency-monitor";
import { createDependencyUnavailableError, createSchemaNotReadyError } from "./errors";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Dependency capability the route needs (R1.6D). Mandatory for business routes; never exposed by the API. */
    capability?: Capability;
  }
}

/**
 * Business routes fail closed while their declared capability is not
 * available, before any handler, authentication or repository call runs.
 * Each route must declare `config.capability` (like `requiredScope`); a route
 * without one fails at registration (startup), so no route can be left on an
 * implicit gate. A renderer outage therefore blocks only issuance, a storage
 * outage only issuance and document reads, and a database outage everything.
 */
export function enforceRouteCapabilities(app: FastifyInstance, monitor: DependencyMonitor): void {
  app.addHook("onRoute", (route) => {
    if (route.config?.capability === undefined) {
      throw new Error(`Business route ${route.method.toString()} ${route.url} declares no capability`);
    }
  });

  app.addHook("onRequest", (request, _reply, done) => {
    const rejection = monitor.gate(request.routeOptions.config.capability!);

    if (rejection === null) {
      done();
      return;
    }

    done(
      rejection.code === "schema_not_ready"
        ? createSchemaNotReadyError()
        : createDependencyUnavailableError(rejection.dependency)
    );
  });
}
