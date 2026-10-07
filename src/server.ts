import "dotenv/config";
import { safeErrorSummary } from "./application/safe-error";

import { buildApplication, type ApplicationContext } from "./app";
import { PrincipalRegistryError } from "./infrastructure/auth/principal-registry";
import { describeConfigError, loadEnv, type AppEnv } from "./infrastructure/config/env";

/*
 * Top-level failure policy (docs/runtime-lifecycle.md):
 *
 *   A. terminate (exit 1): invalid static configuration (including a malformed
 *      principal registry), local initialization
 *      corruption (e.g. packaged migration set inconsistent), cannot bind the
 *      port, programmer errors (uncaught exception / unhandled rejection).
 *   B. stay live, not ready: database unreachable, schema not at expected
 *      head, document storage unusable, renderer unusable. Recovery is
 *      automatic; no restart required.
 *   C. degrade an optional subsystem only: email provider failures affect
 *      email delivery, never readiness.
 */

function writeFatal(event: string, payload: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", time: Date.now(), event, ...payload })}\n`
  );
}

let application: ApplicationContext | null = null;
let termination: Promise<void> | null = null;

/** Single exit path. shutdown() is bounded by APP_SHUTDOWN_TIMEOUT_MS, so this always exits. */
function terminate(exitCode: number, reason: string): Promise<void> {
  termination ??= (async () => {
    const outcome = application ? await application.shutdown(reason) : "completed";
    process.exit(outcome === "completed" ? exitCode : 1);
  })();

  return termination;
}

function installProcessHandlers(): void {
  const onProgrammerError = (kind: string) => (error: unknown) => {
    if (application) {
      application.app.log.fatal({ event: "runtime.fatal", kind, ...safeErrorSummary(error) }, "Programmer error");
    } else {
      writeFatal("runtime.fatal", { kind, ...safeErrorSummary(error) });
    }

    void terminate(1, kind);
  };

  process.on("uncaughtException", onProgrammerError("uncaughtException"));
  process.on("unhandledRejection", onProgrammerError("unhandledRejection"));

  // Credential rotation/revocation without restart (security contract §4).
  // An invalid new registry is rejected and the current one stays active.
  process.on("SIGHUP", () => {
    if (!application) {
      return;
    }

    const result = application.principalRegistry.reload();

    if (result.ok) {
      application.app.log.info(
        { event: "principal_registry.reloaded", principals: result.principals },
        "Principal registry reloaded"
      );
    } else {
      application.app.log.error(
        { event: "principal_registry.reload_rejected", ...safeErrorSummary(result.error) },
        "Principal registry reload rejected; previous registry kept"
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void terminate(0, signal);
    });
  }
}

async function main(): Promise<void> {
  let env: AppEnv;

  try {
    env = loadEnv();
  } catch (error) {
    writeFatal("runtime.config_invalid", describeConfigError(error) ?? { errorName: "unknown" });
    process.exit(1);
  }

  installProcessHandlers();

  try {
    application = buildApplication(env);
  } catch (error) {
    if (error instanceof PrincipalRegistryError) {
      writeFatal("runtime.config_invalid", safeErrorSummary(error));
    } else {
      writeFatal("runtime.init_failed", safeErrorSummary(error));
    }

    process.exit(1);
  }

  try {
    await application.app.listen({
      host: env.HOST,
      port: env.PORT
    });
  } catch (error) {
    application.app.log.fatal({ event: "runtime.bind_failed", ...safeErrorSummary(error) }, "Could not bind");
    await terminate(1, "bind_failed");
    return;
  }

  application.app.log.info(
    {
      event: "runtime.started",
      service: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      ready: application.dependencyMonitor.isReady()
    },
    "Runtime started"
  );
}

main().catch((error: unknown) => {
  writeFatal("runtime.fatal", { kind: "main", ...safeErrorSummary(error) });
  process.exit(1);
});
