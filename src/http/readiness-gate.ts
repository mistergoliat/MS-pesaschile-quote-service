import type { onRequestHookHandler } from "fastify";

import type { DependencyMonitor } from "../application/health/dependency-monitor";
import { createDependencyUnavailableError, createSchemaNotReadyError } from "./errors";

/**
 * Business routes fail closed while the dependency set is not ready, before
 * any handler or repository call runs.
 */
export function createReadinessGate(monitor: DependencyMonitor): onRequestHookHandler {
  return (_request, _reply, done) => {
    const rejection = monitor.businessGate();

    if (rejection === null) {
      done();
      return;
    }

    done(
      rejection.code === "schema_not_ready"
        ? createSchemaNotReadyError()
        : createDependencyUnavailableError(rejection.dependency)
    );
  };
}
