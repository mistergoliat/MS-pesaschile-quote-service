import { Pool, type ClientConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { AppEnv } from "../../config/env";

/** Connection settings shared by the request pool and the dependency probe. */
export function buildConnectionConfig(env: AppEnv): ClientConfig {
  return {
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL_MODE === "require" ? { rejectUnauthorized: false } : false,
    application_name: env.SERVICE_NAME
  };
}

export class PostgresDatabase {
  private readonly pool: Pool;
  private connectionErrorListener: (error: Error) => void = () => undefined;

  public constructor(env: AppEnv) {
    this.pool = new Pool({
      ...buildConnectionConfig(env),
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
      query_timeout: env.DB_QUERY_TIMEOUT_MS,
      statement_timeout: env.DB_QUERY_TIMEOUT_MS
    });
    // An idle pooled client whose server connection dies (database restart,
    // network drop) is reported here. Without a listener Node treats it as an
    // unhandled error event and kills the process.
    this.pool.on("error", (error) => {
      this.connectionErrorListener(error);
    });
  }

  /** Receives idle-connection failures; the pool already discards the broken client. */
  public onConnectionError(listener: (error: Error) => void): void {
    this.connectionErrorListener = listener;
  }

  public query<T extends QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  /**
   * Checks a client out with an error listener attached for as long as it is
   * held. pg-pool removes its own listener on checkout, and a pg Client whose
   * connection dies mid-transaction (database restart, network drop, a
   * connection cut during COMMIT) emits 'error': without a listener Node
   * treats it as an unhandled error event and the process dies (R1.5B4
   * finding). The pending query still rejects normally; a broken client is
   * released with its error so the pool discards it.
   */
  private async checkout(): Promise<{ readonly client: PoolClient; readonly release: () => void }> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    const onError = (error: Error) => {
      broken = error;
      this.connectionErrorListener(error);
    };
    client.on("error", onError);

    return {
      client,
      release: () => {
        client.removeListener("error", onError);
        client.release(broken);
      }
    };
  }

  public async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const { client, release } = await this.checkout();

    try {
      await client.query("begin");
      const result = await work(client);

      try {
        await client.query("commit");
      } catch (error) {
        // The server may or may not have committed: never report this as a
        // known-uncommitted failure.
        throw new CommitOutcomeUnknownError(error);
      }

      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async withAdvisoryLock<T>(
    lockKey: number,
    work: () => Promise<T>
  ): Promise<{ readonly acquired: boolean; readonly result?: T }> {
    const { client, release } = await this.checkout();

    try {
      const lockResult = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1) as acquired",
        [lockKey]
      );

      if (!lockResult.rows[0]?.acquired) {
        return {
          acquired: false
        };
      }

      try {
        return {
          acquired: true,
          result: await work()
        };
      } finally {
        await client
          .query("select pg_advisory_unlock($1)", [lockKey])
          .catch(() => undefined);
      }
    } finally {
      release();
    }
  }
}

/** COMMIT failed; whether the transaction committed is unknown. */
export class CommitOutcomeUnknownError extends Error {
  override readonly name = "CommitOutcomeUnknownError";

  constructor(override readonly cause: unknown) {
    super("Transaction commit outcome is unknown");
  }
}

export interface SqlQueryable {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}
