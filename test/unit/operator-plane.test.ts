import fs from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { buildApplication } from "../../src/app";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { loadEnv } from "../../src/infrastructure/config/env";
import { OPERATOR_EXIT, OperatorUsageError, parseOperatorArguments, resolveOperatorPrincipal } from "../../src/infrastructure/operator/operator-plane";
import { PostgresIssuanceOperationRepository } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { importClosure } from "../helpers/import-closure";
import { testRegistryJson } from "../helpers/test-principals";

/*
 * R1.6C operator plane: strict invocation, W6 operator principal, bounded
 * reason codes, and proof that the operator controls are CLI only (no HTTP
 * route, no scope, no OpenAPI change, nothing calls repair automatically).
 */

const RETRY_SPEC = { quote: "uuid", operation: "uuid", operator: "principal", reason: "code", yes: "switch" } as const;
const RETRY_REQUIRED = ["quote", "operation", "operator", "reason"] as const;
const QUOTE = "0b7c3c1e-6a43-4c0b-9a59-6c3f1e2d4a10";
const OPERATION = "5f0e2a7b-1c9d-4e3f-8a6b-2d7c9e1f3b40";
const valid = ["--quote", QUOTE, "--operation", OPERATION, "--operator", "backoffice", "--reason", "renderer_fixed"];

const usageError = (argv: string[]): OperatorUsageError => {
  try {
    parseOperatorArguments(argv, RETRY_SPEC, RETRY_REQUIRED);
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorUsageError);
    return error as OperatorUsageError;
  }

  throw new Error("expected a usage error");
};

describe("operator argument parsing", () => {
  it("parses the documented invocation; --yes is a value-less switch; UUIDs are normalized", () => {
    expect(parseOperatorArguments(valid, RETRY_SPEC, RETRY_REQUIRED)).toEqual({ quote: QUOTE, operation: OPERATION, operator: "backoffice", reason: "renderer_fixed" });
    expect(parseOperatorArguments([...valid, "--yes"], RETRY_SPEC, RETRY_REQUIRED)).toMatchObject({ yes: true });
    expect(parseOperatorArguments(["--quote", QUOTE.toUpperCase(), ...valid.slice(2)], RETRY_SPEC, RETRY_REQUIRED).quote).toBe(QUOTE);
    expect(parseOperatorArguments(["--limit", "25"], { limit: "limit" })).toEqual({ limit: 25 });
  });

  it("rejects unknown flags, positionals, repeated flags, missing values and missing required flags", () => {
    expect(usageError([...valid, "--force"]).message).toBe("unknown flag");
    expect(usageError([...valid, "--note", "x"]).message).toBe("unknown flag");
    expect(usageError([...valid, "extra"]).message).toBe("unexpected positional argument");
    expect(usageError([...valid, "--quote", QUOTE]).message).toBe("--quote given more than once");
    expect(usageError([...valid, "--yes", "--yes"]).message).toBe("--yes given more than once");
    expect(usageError(["--quote", "--operation", OPERATION]).message).toBe("--quote requires a value");
    expect(usageError(valid.slice(0, 6)).message).toBe("--reason is required");
    expect(usageError([`--quote=${QUOTE}`, ...valid.slice(2)]).message).toBe("unknown flag");
    expect(() => parseOperatorArguments(["--limit", "0"], { limit: "limit" })).toThrow(OperatorUsageError);
    expect(() => parseOperatorArguments(["--limit", "1001"], { limit: "limit" })).toThrow(OperatorUsageError);
  });

  it("BM/BN: reason codes and principal ids are bounded; rejected values are never echoed", () => {
    const hostile = [
      ["--reason", "renderer fixed by Camila Rojas"],
      ["--reason", "renderer_fixed\nINJECTED"],
      ["--reason", "Renderer_Fixed"],
      ["--reason", `r${"x".repeat(64)}`],
      ["--reason", "camila.rojas@example.com"],
      ["--operator", 'backoffice","principalType":"operator'],
      ["--operator", "backoffice\nINJECTED"],
      ["--operator", "Backoffice"],
      ["--quote", "not-a-uuid INJECTED"]
    ];

    for (const [flag, value] of hostile) {
      const argv = [...valid];
      argv[argv.indexOf(flag!) + 1] = value!;
      const message = usageError(argv).message;
      expect(message).toMatch(new RegExp(`^${flag} must be`));
      expect(message).not.toContain("INJECTED");
      expect(message).not.toContain("Camila");
      expect(message).not.toContain('"');
    }
  });
});

describe("W6 operator principal", () => {
  const registry = PrincipalRegistry.load({ kind: "inline", json: testRegistryJson() });

  it("K: a registered operator principal is accepted", () => {
    expect(resolveOperatorPrincipal(registry, "backoffice")).toEqual({ ok: true, principalId: "backoffice" });
    expect(resolveOperatorPrincipal(registry, "supervisor")).toEqual({ ok: true, principalId: "supervisor" });
  });

  it("L–Q: unknown, service, reserved and malformed principals are rejected", () => {
    expect(resolveOperatorPrincipal(registry, "ghost-operator")).toEqual({ ok: false, reason: "unknown" });
    expect(resolveOperatorPrincipal(registry, "sales-integration")).toEqual({ ok: false, reason: "not_operator" });
    expect(resolveOperatorPrincipal(registry, "monitoring")).toEqual({ ok: false, reason: "not_operator" });
    expect(resolveOperatorPrincipal(registry, "system")).toEqual({ ok: false, reason: "reserved" });
    expect(resolveOperatorPrincipal(registry, "legacy-v1")).toEqual({ ok: false, reason: "reserved" });
    expect(resolveOperatorPrincipal(registry, "Back Office")).toEqual({ ok: false, reason: "malformed" });
    expect(resolveOperatorPrincipal(registry, "")).toEqual({ ok: false, reason: "malformed" });
  });

  it("the registry lookup returns the registered principal or null, by exact id", () => {
    expect(registry.find("backoffice")).toMatchObject({ principalId: "backoffice", principalType: "operator" });
    expect(registry.find("BACKOFFICE")).toBeNull();
    expect(registry.find("backoffice ")).toBeNull();
  });
});

describe("T10 reason code", () => {
  it("the primitive refuses a free-text reason before touching the database", async () => {
    const untouchable = {
      query: () => Promise.reject(new Error("database must not be reached")),
      withTransaction: () => Promise.reject(new Error("database must not be reached"))
    };
    const repository = new PostgresIssuanceOperationRepository(untouchable, { leaseMs: 60_000, deadlineMs: 3_600_000 });

    for (const reasonCode of ["free text note", "line\nbreak", "UPPER", "x"]) {
      await expect(repository.createOperatorRetry({ quoteId: QUOTE, failedOperationId: OPERATION, actorPrincipalId: "backoffice", reasonCode })).rejects.toThrow(TypeError);
    }
  });

  it("exit codes are stable", () => {
    expect(OPERATOR_EXIT).toEqual({ OK: 0, FAILED: 1, REFUSED: 2, NOT_APPLICABLE: 3 });
  });
});

describe("operator controls are CLI only (no HTTP surface, no auto repair)", () => {
  const OPERATOR_MODULES = [
    "src/infrastructure/operator/operator-plane.ts",
    "src/infrastructure/operator/failed-issuances.ts",
    "src/infrastructure/operator/issuance-retry.ts",
    "src/infrastructure/operator/document-repair.ts"
  ];
  const OPERATOR_SCRIPTS = ["src/scripts/list-failed-issuances.ts", "src/scripts/retry-issuance.ts", "src/scripts/repair-document-artifact.ts"];

  it("U/§51: the composed application exposes exactly the frozen routes: no retry, repair or failed-issuance route", async () => {
    const env = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:secret@127.0.0.1:1/none",
      QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson(),
      QUOTE_DOCUMENT_STORAGE_ROOT: "./.unused-storage-root"
    });
    const context = buildApplication(env, { logStream: { write: () => undefined } });

    try {
      await context.app.ready();
      const routes = context.app.printRoutes({ commonPrefix: false });
      expect(routes).not.toMatch(/retry|repair|failed|operator|admin|integrity/i);
      // The route tree's segments are exactly those of the frozen V2 API and health.
      const segments = new Set([...routes.matchAll(/(\/[^\s(]*)/g)].map((match) => match[1]!));
      expect(segments.size).toBeGreaterThan(10);
      expect([...segments].filter((segment) => !/^\/(health|live|ready|dependencies|v2\/|drafts|:quoteId|draft|document|deliveries\/|issue|cancel|audit)/.test(segment))).toEqual([]);
    } finally {
      await context.app.close();
    }
  }, 60_000);

  it("the OpenAPI contract defines no operator, retry or repair path and no new scope", () => {
    const openapi = YAML.parse(fs.readFileSync("docs/v2/openapi.yaml", "utf8")) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths).filter((route) => /retry|repair|failed|operator|admin|integrity/i.test(route))).toEqual([]);
    expect(fs.readFileSync("src/application/auth/principal.ts", "utf8")).not.toMatch(/quotes:(admin|operator|repair|retry)/);
  });

  it("the server never reaches the operator modules; only their scripts do; nothing calls repair or retry automatically", () => {
    const runtime = importClosure("src/server.ts");
    expect(runtime.filter((file) => file.includes("/operator/") || OPERATOR_SCRIPTS.includes(file))).toEqual([]);

    const sources = fs
      .readdirSync("src", { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"))
      .filter((file) => !file.startsWith("src/infrastructure/operator/"));
    const callers = (pattern: RegExp) => sources.filter((file) => pattern.test(fs.readFileSync(file, "utf8"))).sort();

    expect(callers(/\brepairDocumentArtifact\(/)).toEqual(["src/scripts/repair-document-artifact.ts"]);
    expect(callers(/\bretryFailedIssuance\(/)).toEqual(["src/scripts/retry-issuance.ts"]);
    expect(callers(/\blistFailedIssuances\(/)).toEqual(["src/scripts/list-failed-issuances.ts"]);
    expect(callers(/\.createOperatorRetry\(/)).toEqual([]);
  });

  it("operator modules read no environment, argv or wall clock; no configuration switch relaxes them", () => {
    for (const file of OPERATOR_MODULES) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env|process\.argv|Date\.now\(|new Date\(\)/);
    }

    const env = fs.readFileSync("src/infrastructure/config/env.ts", "utf8");
    expect(env).not.toMatch(/OPERATOR|REPAIR|ADMIN|BYPASS/);
  });

  it("repair never writes the database and never deletes or renames a file", () => {
    const source = fs.readFileSync("src/infrastructure/operator/document-repair.ts", "utf8");
    expect(source).not.toMatch(/\b(insert|update|delete)\s+(into\s+)?quote_service/i);
    expect(source).not.toMatch(/unlink|rmSync|\brm\(|rename|writeFile|fs\./);
    expect(source).toContain('set transaction isolation level repeatable read, read only');
  });
});
