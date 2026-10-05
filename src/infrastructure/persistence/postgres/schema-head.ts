import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";

import type { SchemaHeadState } from "../../../application/health/dependency-state";
import { MIGRATION_MANIFEST, type MigrationManifestEntry } from "./migration-manifest";
import { MIGRATIONS_DIRECTORY, MIGRATIONS_TABLE } from "./migrations-location";

export const MIGRATION_CHECKSUMS_TABLE = "quote_service.schema_migration_checksums";

/**
 * The migration the running code was written against: the last entry of the
 * generated manifest. Adding a migration means adding the file and running
 * `npm run db:manifest` in the same change, which moves this head.
 */
export const EXPECTED_SCHEMA_HEAD = MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]!.name;

const MIGRATION_NAME_PATTERN = /^\d{6}_[a-z0-9_]+$/;

export class MigrationManifestError extends Error {
  override readonly name = "MigrationManifestError";
}

export interface MigrationManifest {
  readonly names: readonly string[];
  readonly checksums: ReadonlyMap<string, string>;
  readonly expectedHead: string;
}

/** SHA-256 of the migration source with CRLF normalized to LF. */
export function computeMigrationChecksum(content: string): string {
  return crypto.createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Verifies the packaged migration files against the manifest compiled into
 * this build: same names, same order, same checksums, head as expected. Any
 * difference is local packaging corruption, so it throws and the process must
 * not start (and the migration command must not run).
 */
export function loadMigrationManifest(
  directory: string = MIGRATIONS_DIRECTORY,
  manifest: readonly MigrationManifestEntry[] = MIGRATION_MANIFEST
): MigrationManifest {
  if (manifest.length === 0) {
    throw new MigrationManifestError("Migration manifest is empty");
  }

  for (const [index, entry] of manifest.entries()) {
    if (!MIGRATION_NAME_PATTERN.test(entry.name)) {
      throw new MigrationManifestError(`Migration name is not canonical: ${entry.name}`);
    }

    if (index > 0 && manifest[index - 1]!.name >= entry.name) {
      throw new MigrationManifestError(`Migration manifest is not strictly ordered at ${entry.name}`);
    }
  }

  let files: string[];

  try {
    files = fs.readdirSync(directory).filter((file) => file.endsWith(".cjs")).sort();
  } catch {
    throw new MigrationManifestError("Migration directory is not readable");
  }

  const packagedNames = files.map((file) => file.slice(0, -".cjs".length));
  const expectedNames = manifest.map((entry) => entry.name);
  const missing = expectedNames.filter((name) => !packagedNames.includes(name));
  const unexpected = packagedNames.filter((name) => !expectedNames.includes(name));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new MigrationManifestError(
      `Packaged migrations differ from the manifest (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`
    );
  }

  const checksums = new Map<string, string>();

  for (const entry of manifest) {
    const actual = computeMigrationChecksum(
      fs.readFileSync(path.join(directory, `${entry.name}.cjs`), "utf8")
    );

    if (actual !== entry.sha256) {
      throw new MigrationManifestError(`Packaged migration ${entry.name} does not match its manifest checksum`);
    }

    checksums.set(entry.name, entry.sha256);
  }

  return {
    names: expectedNames,
    checksums,
    expectedHead: expectedNames[expectedNames.length - 1]!
  };
}

export interface SchemaHeadEvaluation {
  readonly state: Exclude<SchemaHeadState, "DB_UNAVAILABLE">;
  readonly actualHead: string | null;
}

/**
 * Pure comparison of applied migrations (in application order) against the
 * expected ordered set. `applied === null` means the migrations table is absent.
 */
export function evaluateSchemaHead(
  expected: readonly string[],
  applied: readonly string[] | null
): SchemaHeadEvaluation {
  if (applied === null || applied.length === 0) {
    return {
      state: "SCHEMA_MISSING",
      actualHead: null
    };
  }

  const actualHead = applied[applied.length - 1] ?? null;
  const isPrefix =
    applied.length <= expected.length && applied.every((name, index) => expected[index] === name);

  if (!isPrefix) {
    return {
      state: "SCHEMA_AHEAD_OR_UNKNOWN",
      actualHead
    };
  }

  return {
    state: applied.length === expected.length ? "READY" : "SCHEMA_BEHIND",
    actualHead
  };
}

/**
 * Compares the checksums recorded at apply time with the manifest, for a
 * database already at the expected head. `recorded === null` means the
 * checksum table is absent.
 */
export function evaluateMigrationIntegrity(
  manifest: Pick<MigrationManifest, "names" | "checksums">,
  recorded: ReadonlyMap<string, string> | null
): "READY" | "SCHEMA_INTEGRITY_MISMATCH" | "SCHEMA_INTEGRITY_UNVERIFIED" {
  if (recorded === null) {
    return "SCHEMA_INTEGRITY_UNVERIFIED";
  }

  for (const name of manifest.names) {
    const recordedChecksum = recorded.get(name);

    if (recordedChecksum !== undefined && recordedChecksum !== manifest.checksums.get(name)) {
      return "SCHEMA_INTEGRITY_MISMATCH";
    }
  }

  return manifest.names.every((name) => recorded.has(name)) ? "READY" : "SCHEMA_INTEGRITY_UNVERIFIED";
}

export async function readAppliedMigrations(client: Pick<Client, "query">): Promise<string[] | null> {
  const presence = await client.query<{ present: boolean }>(
    `select to_regclass('public.${MIGRATIONS_TABLE}') is not null as present`
  );

  if (!presence.rows[0]?.present) {
    return null;
  }

  const result = await client.query<{ name: string }>(
    `select name from public.${MIGRATIONS_TABLE} order by id asc`
  );

  return result.rows.map((row) => row.name);
}

export async function readRecordedChecksums(
  client: Pick<Client, "query">
): Promise<Map<string, string> | null> {
  const presence = await client.query<{ present: boolean }>(
    `select to_regclass('${MIGRATION_CHECKSUMS_TABLE}') is not null as present`
  );

  if (!presence.rows[0]?.present) {
    return null;
  }

  const result = await client.query<{ name: string; sha256: string }>(
    `select name, sha256 from ${MIGRATION_CHECKSUMS_TABLE}`
  );

  return new Map(result.rows.map((row) => [row.name, row.sha256]));
}
