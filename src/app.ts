import Fastify, { type FastifyInstance } from "fastify";

import type { AppEnv } from "./infrastructure/config/env";
import { PostgresDatabase } from "./infrastructure/persistence/postgres/postgres";
import { registerRoutes } from "./http/routes";

export interface ApplicationContext {
  app: FastifyInstance;
  database: PostgresDatabase;
}

export function buildApplication(env: AppEnv): ApplicationContext {
  const app: FastifyInstance = Fastify({
    logger: {
      level: env.LOG_LEVEL
    }
  });

  const database = new PostgresDatabase(env);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);

    return reply.status(500).send({
      error: "internal_server_error",
      message: "Unexpected server error"
    });
  });

  app.addHook("onClose", async () => {
    await database.close();
  });

  registerRoutes(app, env, database);

  return {
    app,
    database
  };
}
