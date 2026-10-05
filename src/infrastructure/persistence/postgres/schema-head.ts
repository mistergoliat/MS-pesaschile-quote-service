import fs from "node:fs";

import type { Client } from "pg";

import type { SchemaHeadState } from "../../../application/health/dependency-state";
import { MIGRATIONS_DIRECTORY, MIGRATIONS_TABLE } from "./migrator";

/**
 * The migration the running code was written against. Bumping it is part of
 * adding a migration (R1.4 adds 000006); the manifest check below refuses to
 * boot when the packaged migration set and this constant disagree.
 */
export const EXPECTED_SCHEMA_HEAD = "000005_quote_line_shipping";

const MIGRATION_NAME_PATTERN = /^\d{6}_[a-z0-9_]+$/;

export class MigrationManifestError extends Error {
  override readonly name = "MigrationManifestError";
}

export interface MigrationManifest {
  readonly names: readonly string[];
  readonly expectedHead: string;
}

/**
 * Reads the packaged migration set. A missing or inconsistent set is local
 * packaging corruption, not a runtime dependency failure, so it throws and
 * the process must not start.
 */
export function loadMigrationManifest(
  directory: string = MIGRATIONS_DIRECTORY,
  expectedHead: string = EXPECTED_SCHEMA_HEAD
): MigrationManifest {
  let files: string[];

  try {
    files = fs.readdirSync(directory).filter((file) => file.endsWith(".cjs"));
  } catch {
    throw new MigrationManifestError("Migration directory is not readable");
  }

  const names = files.map((file) => file.slice(0, -".cjs".length)).sort();

  if (names.length === 0) {
    throw new MigrationManifestError("No migrations are packaged");
  }

  const invalid = names.find((name) => !MIGRATION_NAME_PATTERN.test(name));

  if (invalid !== undefined) {
    throw new MigrationManifestError(`Migration name is not canonical: ${invalid}`);
  }

  if (names[names.length - 1] !== expectedHead) {
    throw new MigrationManifestError(
      `Packaged migration head ${names[names.length - 1]} does not match expected head ${expectedHead}`
    );
  }

  return {
    names,
    expectedHead
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
