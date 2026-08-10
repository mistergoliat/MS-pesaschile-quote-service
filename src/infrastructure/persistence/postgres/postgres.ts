import { performance } from "node:perf_hooks";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import type {
  DatabaseHealthPort,
  DatabaseHealthStatus
} from "../../../application/ports/database-health-port";
import type { AppEnv } from "../../config/env";

export class PostgresDatabase implements DatabaseHealthPort {
  private readonly pool: Pool;

  public constructor(env: AppEnv) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL_MODE === "require" ? { rejectUnauthorized: false } : false
    });
  }

  public query<T extends QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  public async checkHealth(timeoutMs: number): Promise<DatabaseHealthStatus> {
    const startedAt = performance.now();

    try {
      await Promise.race([
        this.query("select 1"),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("database healthcheck timeout"));
          }, timeoutMs);
        })
      ]);

      return {
        status: "up",
        latencyMs: Math.round(performance.now() - startedAt)
      };
    } catch {
      return {
        status: "down",
        latencyMs: Math.round(performance.now() - startedAt)
      };
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
