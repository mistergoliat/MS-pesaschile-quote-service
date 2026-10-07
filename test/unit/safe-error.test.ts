import { describe, expect, it } from "vitest";

import { safeErrorSummary } from "../../src/application/safe-error";
import { migrationErrorSummary } from "../../src/infrastructure/persistence/postgres/migration-error-summary";
import { evaluateSchemaHead } from "../../src/infrastructure/persistence/postgres/schema-head";
import { MigrationIntegrityError } from "../../src/infrastructure/persistence/postgres/migrator";
import { z } from "zod";
import { describeConfigError } from "../../src/infrastructure/config/env";

describe("bounded error summaries", () => {
  it("never serializes hostile fields, names, codes, or nested objects", () => {
    const error = Object.assign(new Error("SENTINEL_message"), {
      name: "SENTINEL_name", code: "SENTINEL_code", stack: "SENTINEL_stack",
      detail: "SENTINEL_detail", hint: "SENTINEL_hint", query: "SENTINEL_query",
      cause: { password: "SENTINEL_cause" }, toString: () => "SENTINEL_toString"
    });
    expect(safeErrorSummary(error)).toEqual({ errorName: "unknown", errorCode: null });
  });
  it("does not invoke accessors or hostile proxy traps", () => {
    const error = Object.defineProperty({}, "code", { get() { throw new Error("SENTINEL_getter"); } });
    expect(safeErrorSummary(error)).toEqual({ errorName: "unknown", errorCode: null });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SENTINEL_proxy"); }, getPrototypeOf() { throw new Error(); } });
    expect(safeErrorSummary(proxy)).toEqual({ errorName: "unknown", errorCode: null });
    expect(describeConfigError(proxy)).toBeNull();
    expect(migrationErrorSummary(proxy)).toEqual({ errorName: "unknown", errorCode: null });
  });
  it.each(["23514", "28P01", "P0001", "42501", "ECONNREFUSED", "ERR_TLS_CERT_ALTNAME_INVALID"])("retains safe diagnostic %s", (code) => {
    expect(safeErrorSummary(Object.assign(new Error("private"), { code }))).toEqual({ errorName: "Error", errorCode: code });
  });
  it("extracts migration codes and UUIDs while discarding even hostile report detail", () => {
    const quoteId = "11111111-1111-4111-8111-111111111111";
    const error = Object.assign(new Error(`V1 -> V2 migration exceptions: 2 row(s) violate the frozen mapping; nothing was migrated.\n  ${quoteId} document_missing SENTINEL_row\n  - idempotency_request_hash_invalid SENTINEL_operation`), { code: "P0001" });
    expect(migrationErrorSummary(error)).toEqual({ errorName: "Error", errorCode: "P0001", migrationName: "000007_quote_v2_persistence", exceptionCount: 2, exceptions: [{ quoteId, exceptionCode: "document_missing" }, { quoteId: null, exceptionCode: "idempotency_request_hash_invalid" }] });
    expect(JSON.stringify(migrationErrorSummary(error))).not.toContain("SENTINEL");
  });
  it("does not recognize arbitrary driver prose as a migration report", () => {
    expect(migrationErrorSummary(Object.assign(new Error("password=SENTINEL"), { code: "P0001" }))).toEqual({ errorName: "Error", errorCode: "P0001" });
  });
  it("does not publish unknown database-supplied migration names", () => {
    expect(evaluateSchemaHead(["000001_known"], ["SENTINEL_database"])).toEqual({ state: "SCHEMA_AHEAD_OR_UNKNOWN", actualHead: null });
  });
  it("preserves known checksum identifiers and suppresses foreign names", () => {
    const error = new MigrationIntegrityError("SENTINEL_message", ["000007_quote_v2_persistence", "SENTINEL_database_name"]);
    expect(migrationErrorSummary(error)).toMatchObject({ errorName: "MigrationIntegrityError", phase: "checksum_verification", migrationNames: ["000007_quote_v2_persistence"], schemaStatus: "SCHEMA_INTEGRITY_MISMATCH" });
    expect(JSON.stringify(migrationErrorSummary(error))).not.toContain("SENTINEL");
  });
  it("does not trust third-party Zod issue prose or arbitrary paths", () => {
    const error = new z.ZodError([{ code: "custom", path: ["SENTINEL_path"], message: "SENTINEL_message" }]);
    expect(describeConfigError(error)).toEqual({ issues: [{ path: "CONFIGURATION", message: "Invalid configuration value or combination" }] });
  });
});
