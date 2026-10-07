import { runner } from "node-pg-migrate";
import { Client, type ClientConfig } from "pg";
import { buildConnectionConfig } from "./connection-config";

import { MIGRATIONS_DIRECTORY, MIGRATIONS_TABLE } from "./migrations-location";
import {
  MIGRATION_CHECKSUMS_TABLE,
  loadMigrationManifest,
  readAppliedMigrations,
  readRecordedChecksums,
  type MigrationManifest
} from "./schema-head";

export { MIGRATIONS_DIRECTORY, MIGRATIONS_TABLE } from "./migrations-location";

export class MigrationIntegrityError extends Error {
  override readonly name = "MigrationIntegrityError";
  constructor(message: string, readonly migrationNames: readonly string[] = []) { super(message); }
}

export interface RunMigrationsInput {
  databaseUrl: string;
  direction: "up" | "down";
  connectionConfig?: ClientConfig;
}

/**
 * The explicit, operator-run DDL path (the server never migrates):
 *   1. the packaged files must match the manifest compiled into this build;
 *   2. every checksum already recorded in the database must match the
 *      packaged file of the same name ("same name, changed bytes" refuses);
 *   3. node-pg-migrate applies pending migrations in one transaction;
 *   4. checksums are recorded for every applied migration not yet recorded
 *      (`applied` for this run's migrations, `backfilled` for older ones).
 */
export async function runMigrations({
  databaseUrl,
  direction,
  connectionConfig
}: RunMigrationsInput): Promise<void> {
  const manifest = loadMigrationManifest();
  const client = new Client(connectionConfig ?? buildConnectionConfig({ DATABASE_URL: databaseUrl }));
  client.on("error", () => undefined);
  await client.connect();

  try {
    await assertRecordedChecksums(client, manifest);

    const options = {
      dbClient: client,
      dir: MIGRATIONS_DIRECTORY,
      direction,
      migrationsTable: MIGRATIONS_TABLE,
      checkOrder: true,
      // All pending migrations commit or roll back together, so a failed V1
      // data migration (000007) leaves no partial head behind. Must be set
      // explicitly: the programmatic runner does not default it.
      singleTransaction: true,
      noLock: false,
      log: () => undefined
    } as const;

    const ran = await runner(
      direction === "down"
        ? {
            ...options,
            count: 1
          }
        : options
    );

    if (direction === "up") {
      await recordChecksums(client, manifest, new Set(ran.map((migration) => migration.name)));
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertRecordedChecksums(client: Client, manifest: MigrationManifest): Promise<void> {
  const recorded = await readRecordedChecksums(client);

  if (recorded === null) {
    return;
  }

  const mismatched = [...recorded.entries()]
    .filter(([name, sha256]) => manifest.checksums.get(name) !== sha256)
    .map(([name]) => name);

  if (mismatched.length > 0) {
    throw new MigrationIntegrityError(
      `Applied migration(s) differ from the packaged files or are unknown to this build: ${mismatched.join(", ")}`,
      mismatched.filter((name) => manifest.names.includes(name))
    );
  }
}

async function recordChecksums(
  client: Client,
  manifest: MigrationManifest,
  appliedByThisRun: ReadonlySet<string>
): Promise<void> {
  const [applied, recorded] = await Promise.all([
    readAppliedMigrations(client),
    readRecordedChecksums(client)
  ]);

  // Below 000006 there is nowhere to record yet.
  if (applied === null || recorded === null) {
    return;
  }

  const missing = applied.filter((name) => !recorded.has(name));

  for (const name of missing) {
    const sha256 = manifest.checksums.get(name);

    if (sha256 === undefined) {
      throw new MigrationIntegrityError(`Applied migration ${name} is unknown to this build`);
    }

    await client.query(
      `insert into ${MIGRATION_CHECKSUMS_TABLE} (name, sha256, provenance) values ($1, $2, $3)
       on conflict (name) do nothing`,
      [name, sha256, appliedByThisRun.has(name) ? "applied" : "backfilled"]
    );
  }
}

/**
 * Re-applies the runtime role's grants (idempotent). Needed when the
 * quote_runtime role is provisioned after the migrations ran. Must run as the
 * migration principal (object owner).
 */
export async function applyRuntimeGrants(databaseUrl: string, connectionConfig?: ClientConfig): Promise<{ readonly runtimeRolePresent: boolean }> {
  const client = new Client(connectionConfig ?? buildConnectionConfig({ DATABASE_URL: databaseUrl }));
  client.on("error", () => undefined);
  await client.connect();

  try {
    const role = await client.query<{ present: boolean }>(
      "select exists (select 1 from pg_roles where rolname = 'quote_runtime') as present"
    );
    await client.query("select quote_service.apply_runtime_grants()");

    return {
      runtimeRolePresent: role.rows[0]?.present === true
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
