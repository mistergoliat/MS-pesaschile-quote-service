import { Client, type ClientConfig } from "pg";

import {
  PROBE_OK,
  probeFailed,
  type DatabaseProbePort,
  type DatabaseProbeResult
} from "../../../application/health/dependency-state";
import { classifyDatabaseFailure } from "./postgres-errors";
import {
  evaluateMigrationIntegrity,
  evaluateSchemaHead,
  readAppliedMigrations,
  readRecordedChecksums,
  type MigrationManifest
} from "./schema-head";

/**
 * Probes connectivity and schema head over a dedicated short-lived connection
 * whose connect and query timeouts equal the probe timeout. Using a separate
 * client keeps a slow or dead database from parking probe work inside the
 * request pool.
 */
export class PostgresDependencyProbe implements DatabaseProbePort {
  constructor(
    private readonly connectionConfig: ClientConfig,
    private readonly manifest: Pick<MigrationManifest, "names" | "checksums">
  ) {}

  async probe(timeoutMs: number): Promise<DatabaseProbeResult> {
    const client = new Client({
      ...this.connectionConfig,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs
    });
    // A dropped probe connection must never surface as an unhandled 'error' event.
    client.on("error", () => undefined);

    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      return {
        connection: probeFailed(classifyDatabaseFailure(error)),
        schema: {
          state: "DB_UNAVAILABLE",
          actualHead: null
        }
      };
    }

    try {
      const applied = await readAppliedMigrations(client);
      const evaluation = evaluateSchemaHead(this.manifest.names, applied);

      if (evaluation.state !== "READY") {
        return {
          connection: PROBE_OK,
          schema: evaluation
        };
      }

      return {
        connection: PROBE_OK,
        schema: {
          state: evaluateMigrationIntegrity(this.manifest, await readRecordedChecksums(client)),
          actualHead: evaluation.actualHead
        }
      };
    } catch (error) {
      const failureCategory = classifyDatabaseFailure(error);

      // Connected but could not inspect the migrations table (e.g. missing
      // privilege): connectivity is fine, the schema head is unknown.
      if (failureCategory === "permission") {
        return {
          connection: PROBE_OK,
          schema: {
            state: "SCHEMA_AHEAD_OR_UNKNOWN",
            actualHead: null
          }
        };
      }

      return {
        connection: probeFailed(failureCategory),
        schema: {
          state: "DB_UNAVAILABLE",
          actualHead: null
        }
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
