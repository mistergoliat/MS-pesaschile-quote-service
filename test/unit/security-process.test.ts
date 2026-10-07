import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { testRegistryJson } from "../helpers/test-principals";

function run(script: string, mode: string, hostileCode: boolean): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", path.resolve("test/process/security-error-preload.cjs"), "--import", "tsx", script, ...(script.endsWith("migrate.ts") ? ["up"] : [])], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://test@127.0.0.1:1/unused", MIGRATION_DATABASE_URL: "postgres://test@127.0.0.1:1/unused", DATABASE_SSL_MODE: "disable", DATABASE_SSL_CA_FILE: undefined, QUOTE_DOCUMENT_STORAGE_ROOT: "./.unused-security-storage", QUOTE_PRINCIPAL_REGISTRY_FILE: undefined, QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson(), QUOTE_EMAIL_PROVIDER: "disabled", HOST: "127.0.0.1", PORT: "0", SECURITY_TEST_FAILURE: mode, SECURITY_TEST_HOSTILE_CODE: hostileCode ? "1" : "", DOTENV_CONFIG_PATH: path.resolve("test/process/no-such-dotenv") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => { output += data.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Security process timed out")); }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

describe("real process error-output boundaries", () => {
  it.each(["init", "bind", "unhandled", "uncaught"])("server %s keeps every hostile field out of stderr and logs", async (mode) => {
    const result = await run("src/server.ts", mode, false);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("SECURITY_SENTINEL");
    expect(result.output).toContain('"errorCode":"23514"');
    expect(result.output).toContain('"errorName":"unknown"');
  }, 30_000);
  it.each(["src/scripts/migrate.ts", "src/scripts/db-check.ts", "src/scripts/apply-runtime-grants.ts", "src/scripts/verify-document-artifacts.ts", "src/scripts/list-failed-issuances.ts"])("%s suppresses hostile database fields", async (script) => {
    const result = await run(script, "db", false);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain("SECURITY_SENTINEL");
    expect(result.output).toMatch(/failed|not_ready|database_unavailable/);
    if (!script.includes("db-check") && !script.includes("list-failed")) expect(result.output).toContain('"errorCode":"23514"');
  }, 30_000);
  it("does not echo an arbitrary error code in fatal output", async () => {
    const result = await run("src/server.ts", "init", true);
    expect(result.output).not.toContain("SECURITY_SENTINEL");
    expect(result.output).toContain('"errorCode":null');
  }, 30_000);
  it("schema query failures are sanitized after a successful connection", async () => {
    const result = await run("src/scripts/db-check.ts", "schema", false);
    expect(result.code).toBe(2);
    expect(result.output).not.toContain("SECURITY_SENTINEL");
    expect(result.output).toContain("DB_UNAVAILABLE");
  }, 30_000);
  it("migration CLI preserves recognized migration UUID/code diagnostics only", async () => {
    const result = await run("src/scripts/migrate.ts", "migration-report", false);
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("SECURITY_SENTINEL");
    expect(result.output).toContain('"tool":"db:migrate"');
    expect(result.output).toContain('"errorCode":"P0001"');
    expect(result.output).toContain('"migrationName":"000007_quote_v2_persistence"');
    expect(result.output).toContain('"exceptionCode":"document_missing"');
  }, 30_000);
});
