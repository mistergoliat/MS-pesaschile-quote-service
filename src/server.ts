import "dotenv/config";

import { buildApplication } from "./app";
import { loadEnv } from "./infrastructure/config/env";

async function main(): Promise<void> {
  const env = loadEnv();
  const application = buildApplication(env);
  const { app, lifecycleState } = application;

  await app.listen({
    host: env.HOST,
    port: env.PORT
  });

  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    lifecycleState.markShuttingDown();
    app.log.info({ signal }, "Shutdown signal received");

    shutdownPromise = Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Graceful shutdown timed out"));
        }, env.APP_SHUTDOWN_TIMEOUT_MS);
        timer.unref();
      })
    ])
      .then(() => {
        app.log.info({ signal }, "Application shutdown completed");
      })
      .catch((error) => {
        app.log.error(
          {
            signal,
            error: error instanceof Error ? error.message : "unknown"
          },
          "Application shutdown failed"
        );
        process.exitCode = 1;
      });

    return shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

void main();
