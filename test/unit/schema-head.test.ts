import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIRECTORY } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  EXPECTED_SCHEMA_HEAD,
  evaluateSchemaHead,
  loadMigrationManifest,
  MigrationManifestError
} from "../../src/infrastructure/persistence/postgres/schema-head";

const EXPECTED = ["000001_a", "000002_b", "000003_c"];
const temporaryDirectories: string[] = [];

function migrationDirectory(files: string[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quote-migrations-"));
  temporaryDirectories.push(directory);

  for (const file of files) {
    fs.writeFileSync(path.join(directory, file), "module.exports = {};");
  }

  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("evaluateSchemaHead", () => {
  it("is READY when applied equals expected", () => {
    expect(evaluateSchemaHead(EXPECTED, EXPECTED)).toEqual({ state: "READY", actualHead: "000003_c" });
  });

  it("is SCHEMA_MISSING when the migrations table is absent or empty", () => {
    expect(evaluateSchemaHead(EXPECTED, null)).toEqual({ state: "SCHEMA_MISSING", actualHead: null });
    expect(evaluateSchemaHead(EXPECTED, [])).toEqual({ state: "SCHEMA_MISSING", actualHead: null });
  });

  it("is SCHEMA_BEHIND when applied is a strict prefix", () => {
    expect(evaluateSchemaHead(EXPECTED, ["000001_a", "000002_b"])).toEqual({
      state: "SCHEMA_BEHIND",
      actualHead: "000002_b"
    });
  });

  it("is SCHEMA_AHEAD_OR_UNKNOWN for extra, foreign or out-of-order migrations", () => {
    expect(evaluateSchemaHead(EXPECTED, [...EXPECTED, "000004_d"]).state).toBe("SCHEMA_AHEAD_OR_UNKNOWN");
    expect(evaluateSchemaHead(EXPECTED, ["000001_a", "000002_x"]).state).toBe("SCHEMA_AHEAD_OR_UNKNOWN");
    expect(evaluateSchemaHead(EXPECTED, ["000002_b", "000001_a"]).state).toBe("SCHEMA_AHEAD_OR_UNKNOWN");
  });
});

describe("loadMigrationManifest", () => {
  it("accepts the packaged migration set and its expected head", () => {
    const manifest = loadMigrationManifest();

    expect(manifest.expectedHead).toBe(EXPECTED_SCHEMA_HEAD);
    expect(manifest.names[manifest.names.length - 1]).toBe(EXPECTED_SCHEMA_HEAD);
    expect(manifest.names).toEqual(
      fs
        .readdirSync(MIGRATIONS_DIRECTORY)
        .filter((file) => file.endsWith(".cjs"))
        .map((file) => file.replace(/\.cjs$/, ""))
        .sort()
    );
  });

  it("orders migrations by name and ignores non-migration files", () => {
    const directory = migrationDirectory(["000002_b.cjs", "000001_a.cjs", "README.md"]);

    expect(loadMigrationManifest(directory, "000002_b").names).toEqual(["000001_a", "000002_b"]);
  });

  it("refuses a packaged head that disagrees with the code's expected head", () => {
    const directory = migrationDirectory(["000001_a.cjs", "000002_b.cjs"]);

    expect(() => loadMigrationManifest(directory, "000003_c")).toThrow(MigrationManifestError);
  });

  it("refuses an empty, unreadable or non-canonical migration set", () => {
    expect(() => loadMigrationManifest(migrationDirectory([]), "000001_a")).toThrow(MigrationManifestError);
    expect(() => loadMigrationManifest(path.join(os.tmpdir(), "does-not-exist-quote"), "x")).toThrow(
      MigrationManifestError
    );
    expect(() => loadMigrationManifest(migrationDirectory(["1_bad.cjs"]), "1_bad")).toThrow(MigrationManifestError);
  });
});
