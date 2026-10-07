import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresTlsFixture } from "../../scripts/postgres-tls-fixture.mjs";
import { buildConnectionConfig, DatabaseTransportConfigError } from "../../src/infrastructure/persistence/postgres/connection-config";
import { loadEnv, loadMigrationEnv, describeConfigError } from "../../src/infrastructure/config/env";
import { PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { withOperatorDatabase } from "../../src/infrastructure/operator/operator-plane";
import { testRegistryJson } from "../helpers/test-principals";

const execute = promisify(execFile);
let fixture: ReturnType<typeof createPostgresTlsFixture>;
let rawEnv: NodeJS.ProcessEnv;

async function connect(mode: "disable" | "require" | "verify-full", url = fixture.url, caFile = fixture.caFile): Promise<boolean> {
  const client = new Client({ ...buildConnectionConfig({ DATABASE_URL: url, DATABASE_SSL_MODE: mode, ...(mode === "verify-full" ? { DATABASE_SSL_CA_FILE: caFile } : {}) }), connectionTimeoutMillis: 3_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const result = await client.query<{ ssl: boolean }>("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
    return result.rows[0]!.ssl;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function command(script: string, overrides: NodeJS.ProcessEnv = {}): Promise<{ code: number; output: string }> {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", `src/scripts/${script}.ts`, ...(script === "migrate" ? ["up"] : [])], { env: { ...process.env, ...rawEnv, ...overrides }, timeout: 20_000 });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: result.stdout + result.stderr };
  }
}

beforeAll(async () => {
  fixture = createPostgresTlsFixture();
  rawEnv = { NODE_ENV: "production", DATABASE_URL: fixture.url, MIGRATION_DATABASE_URL: fixture.url, DATABASE_SSL_MODE: "verify-full", DATABASE_SSL_CA_FILE: fixture.caFile, QUOTE_DOCUMENT_STORAGE_ROOT: path.join(path.dirname(fixture.caFile), "documents"), QUOTE_PRINCIPAL_REGISTRY_FILE: undefined, QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson(), QUOTE_EMAIL_PROVIDER: "disabled", DOTENV_CONFIG_PATH: path.resolve("test/process/no-such-dotenv") };
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await connect("disable"); break; } catch {
      if (Date.now() > deadline) throw new Error("TLS fixture PostgreSQL readiness timed out");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}, 180_000);
afterAll(() => fixture?.close(), 60_000);

describe("real PostgreSQL TLS and shared transport paths", () => {
  it("disable connects without TLS; legacy require encrypts without authenticating", async () => {
    expect(await connect("disable")).toBe(false);
    // IP does NOT match the server certificate. require deliberately still accepts it.
    expect(await connect("require", fixture.url.replace("localhost", "127.0.0.1"))).toBe(true);
  });
  it("verify-full accepts a trusted CA with matching DNS name", async () => {
    expect(await connect("verify-full")).toBe(true);
  });
  it("rejects an untrusted CA and a hostname mismatch (including IP identity)", async () => {
    await expect(connect("verify-full", fixture.url, fixture.untrustedCaFile)).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    await expect(connect("verify-full", fixture.url.replace("localhost", "127.0.0.1"))).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
  it("rejects missing, unreadable, malformed, oversized and non-file CA sources before connecting", () => {
    const badFile = path.join(path.dirname(fixture.caFile), "SENTINEL_CA_PATH");
    for (const value of [undefined, badFile, path.dirname(fixture.caFile)]) {
      expect(() => loadMigrationEnv({ ...rawEnv, DATABASE_SSL_CA_FILE: value })).toThrow(DatabaseTransportConfigError);
    }
    for (const content of ["SENTINEL_CA_CONTENT", "x".repeat(256 * 1024 + 1), fs.readFileSync(fixture.caFile, "utf8") + "SENTINEL_EXTRA"]) {
      fs.writeFileSync(badFile, content);
      let caught: unknown;
      try { loadEnv({ ...rawEnv, DATABASE_SSL_CA_FILE: badFile }); } catch (error) { caught = error; }
      expect(describeConfigError(caught)).toEqual({ issues: [{ path: "DATABASE_TRANSPORT", message: "DB_CA_INVALID" }] });
      expect(JSON.stringify(describeConfigError(caught))).not.toContain("SENTINEL");
    }
  });
  it.each(["sslmode", "sslcert", "sslrootcert", "sslkey", "ssl", "rejectUnauthorized", "sslnegotiation", "uselibpqcompat", "host", "SSLMODE"])("fails closed for URL override %s", (key) => {
    expect(() => loadMigrationEnv({ ...rawEnv, MIGRATION_DATABASE_URL: `${fixture.url}?${key}=SENTINEL` })).toThrow(DatabaseTransportConfigError);
    expect(() => loadEnv({ ...rawEnv, DATABASE_URL: `${fixture.url}?${key}=SENTINEL` })).toThrow(DatabaseTransportConfigError);
  });
  it("production permits loopback plaintext or verify-full and rejects remote plaintext and require", () => {
    expect(() => buildConnectionConfig({ DATABASE_URL: fixture.url, NODE_ENV: "production", DATABASE_SSL_MODE: "disable" })).not.toThrow();
    expect(() => buildConnectionConfig({ DATABASE_URL: fixture.url.replace("localhost", "database.internal"), NODE_ENV: "production" })).toThrow(DatabaseTransportConfigError);
    expect(() => buildConnectionConfig({ DATABASE_URL: fixture.url, NODE_ENV: "production", DATABASE_SSL_MODE: "require" })).toThrow(DatabaseTransportConfigError);
    const ipv6 = new Client(buildConnectionConfig({ DATABASE_URL: "postgres://test@[::1]:5432/test", NODE_ENV: "production", DATABASE_SSL_MODE: "disable" }));
    expect(ipv6.host).toBe("::1");
  });
  it("all maintenance commands and runtime/operator pool use TLS; credentials stay separate", async () => {
    // Reject all plaintext TCP connections: success below requires actual TLS, not a config assertion.
    execFileSync("docker", ["exec", "-u", "postgres", fixture.name, "sh", "-ec", 'printf "hostnossl all all 0.0.0.0/0 reject\\nhostnossl all all ::0/0 reject\\n" > /tmp/hba; cat "$PGDATA/pg_hba.conf" >> /tmp/hba; cat /tmp/hba > "$PGDATA/pg_hba.conf"; pg_ctl reload'], { stdio: "pipe" });
    await expect(connect("disable")).rejects.toThrow();
    for (const script of ["migrate", "db-check", "apply-runtime-grants", "verify-document-artifacts", "list-failed-issuances"]) {
      const result = await command(script, script === "list-failed-issuances" ? {} : { DATABASE_URL: fixture.url.replace("fixture-only", "SENTINEL_WRONG_RUNTIME_PASSWORD") });
      expect(result.code, result.output).toBe(script === "apply-runtime-grants" ? 2 : 0);
      expect(result.output).not.toContain("SENTINEL");
    }
    const env = loadEnv(rawEnv);
    const database = new PostgresDatabase(env);
    try {
      expect((await database.query<{ ssl: boolean }>("select ssl from pg_stat_ssl where pid = pg_backend_pid()")).rows[0]!.ssl).toBe(true);
    } finally { await database.close(); }
    const operator = await withOperatorDatabase(env, async (db) => ({ exitCode: 0, body: { ssl: (await db.query<{ ssl: boolean }>("select ssl from pg_stat_ssl where pid = pg_backend_pid()")).rows[0]!.ssl } }));
    expect(operator).toEqual({ exitCode: 0, body: { ssl: true } });
    expect((await command("list-failed-issuances", { DATABASE_URL: fixture.url.replace("fixture-only", "SENTINEL_WRONG_RUNTIME_PASSWORD") })).code).toBe(1);
  }, 120_000);
  it("every CLI rejects untrusted CA/host mismatch without emitting secrets or certificate bytes", async () => {
    for (const overrides of [{ DATABASE_SSL_CA_FILE: fixture.untrustedCaFile }, { DATABASE_URL: fixture.url.replace("localhost", "127.0.0.1"), MIGRATION_DATABASE_URL: fixture.url.replace("localhost", "127.0.0.1") }]) {
      for (const script of ["migrate", "db-check", "apply-runtime-grants", "verify-document-artifacts", "list-failed-issuances"]) {
        const result = await command(script, overrides);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).not.toContain("fixture-only");
        expect(result.output).not.toContain("BEGIN CERTIFICATE");
        expect(result.output).not.toContain(fixture.caFile);
        expect(result.output).not.toContain("127.0.0.1");
      }
    }
  }, 120_000);
});
