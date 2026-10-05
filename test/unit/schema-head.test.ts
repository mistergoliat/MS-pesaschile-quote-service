import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MIGRATION_MANIFEST } from "../../src/infrastructure/persistence/postgres/migration-manifest";
import { MIGRATIONS_DIRECTORY } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  EXPECTED_SCHEMA_HEAD,
  computeMigrationChecksum,
  evaluateMigrationIntegrity,
  evaluateSchemaHead,
  loadMigrationManifest,
  MigrationManifestError
} from "../../src/infrastructure/persistence/postgres/schema-head";

const EXPECTED = ["000001_a", "000002_b", "000003_c"];
const temporaryDirectories: string[] = [];

function migrationDirectory(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quote-migrations-"));
  temporaryDirectories.push(directory);

  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, file), content);
  }

  return directory;
}

function manifestFor(files: Record<string, string>) {
  return Object.entries(files)
    .filter(([file]) => file.endsWith(".cjs"))
    .map(([file, content]) => ({ name: file.replace(/\.cjs$/, ""), sha256: computeMigrationChecksum(content) }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

describe("evaluateMigrationIntegrity", () => {
  const manifest = {
    names: ["000001_a", "000002_b"],
    checksums: new Map([
      ["000001_a", "a".repeat(64)],
      ["000002_b", "b".repeat(64)]
    ])
  };

  it("is READY when every applied migration has its packaged checksum recorded", () => {
    expect(evaluateMigrationIntegrity(manifest, new Map(manifest.checksums))).toBe("READY");
  });

  it("detects same name with changed bytes", () => {
    expect(
      evaluateMigrationIntegrity(manifest, new Map([["000001_a", "a".repeat(64)], ["000002_b", "c".repeat(64)]]))
    ).toBe("SCHEMA_INTEGRITY_MISMATCH");
  });

  it("is UNVERIFIED when a checksum is missing or the table is absent", () => {
    expect(evaluateMigrationIntegrity(manifest, new Map([["000001_a", "a".repeat(64)]]))).toBe(
      "SCHEMA_INTEGRITY_UNVERIFIED"
    );
    expect(evaluateMigrationIntegrity(manifest, null)).toBe("SCHEMA_INTEGRITY_UNVERIFIED");
  });
});

describe("computeMigrationChecksum", () => {
  it("normalizes CRLF so Windows and Linux checkouts agree", () => {
    expect(computeMigrationChecksum("a\r\nb\r\n")).toBe(computeMigrationChecksum("a\nb\n"));
    expect(computeMigrationChecksum("a\nb\n")).not.toBe(computeMigrationChecksum("a\nc\n"));
  });
});

describe("loadMigrationManifest", () => {
  it("the compiled manifest matches the packaged migration files (run npm run db:manifest after adding one)", () => {
    const manifest = loadMigrationManifest();

    expect(manifest.expectedHead).toBe(EXPECTED_SCHEMA_HEAD);
    expect(EXPECTED_SCHEMA_HEAD).toBe("000008_quote_v2_runtime_grants");
    expect(manifest.names).toEqual(
      fs
        .readdirSync(MIGRATIONS_DIRECTORY)
        .filter((file) => file.endsWith(".cjs"))
        .map((file) => file.replace(/\.cjs$/, ""))
        .sort()
    );
    expect(manifest.names).toEqual(MIGRATION_MANIFEST.map((entry) => entry.name));
  });

  it("accepts a directory that matches its manifest and ignores non-migration files", () => {
    const files = { "000001_a.cjs": "one", "000002_b.cjs": "two" };
    const directory = migrationDirectory({ ...files, "README.md": "notes" });

    expect(loadMigrationManifest(directory, manifestFor(files)).names).toEqual(["000001_a", "000002_b"]);
  });

  it("refuses a missing packaged migration", () => {
    const files = { "000001_a.cjs": "one", "000002_b.cjs": "two" };
    const directory = migrationDirectory({ "000001_a.cjs": "one" });

    expect(() => loadMigrationManifest(directory, manifestFor(files))).toThrow(/missing: 000002_b/);
  });

  it("refuses an unexpected packaged migration (head mismatch)", () => {
    const files = { "000001_a.cjs": "one" };
    const directory = migrationDirectory({ ...files, "000002_b.cjs": "two" });

    expect(() => loadMigrationManifest(directory, manifestFor(files))).toThrow(/unexpected: 000002_b/);
  });

  it("refuses a packaged migration whose bytes changed", () => {
    const files = { "000001_a.cjs": "one", "000002_b.cjs": "two" };
    const directory = migrationDirectory({ "000001_a.cjs": "one", "000002_b.cjs": "two, edited" });

    expect(() => loadMigrationManifest(directory, manifestFor(files))).toThrow(MigrationManifestError);
  });

  it("refuses a manifest that is unordered, empty or non-canonical", () => {
    const files = { "000001_a.cjs": "one", "000002_b.cjs": "two" };
    const directory = migrationDirectory(files);

    expect(() => loadMigrationManifest(directory, [...manifestFor(files)].reverse())).toThrow(/strictly ordered/);
    expect(() => loadMigrationManifest(directory, [])).toThrow(/empty/);
    expect(() => loadMigrationManifest(directory, [{ name: "1_bad", sha256: "a".repeat(64) }])).toThrow(/canonical/);
    expect(() => loadMigrationManifest(path.join(os.tmpdir(), "does-not-exist-quote"), manifestFor(files))).toThrow(
      /not readable/
    );
  });
});
