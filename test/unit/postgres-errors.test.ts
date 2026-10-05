import { describe, expect, it } from "vitest";

import {
  classifyDatabaseFailure,
  isDatabaseUnavailableError,
  isSchemaNotReadyError
} from "../../src/infrastructure/persistence/postgres/postgres-errors";

function codedError(code: string, message = "error"): Error {
  return Object.assign(new Error(message), { code });
}

describe("postgres error classification", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "57P01", "57P03", "53300", "08006", "28P01", "3D000"])(
    "treats %s as database unavailable",
    (code) => {
      expect(isDatabaseUnavailableError(codedError(code))).toBe(true);
    }
  );

  it.each([
    "Connection terminated unexpectedly",
    "timeout exceeded when trying to connect",
    "Client has encountered a connection error and is not queryable"
  ])("treats driver message %j as database unavailable", (message) => {
    expect(isDatabaseUnavailableError(new Error(message))).toBe(true);
  });

  it("does not treat statement errors as unavailability", () => {
    expect(isDatabaseUnavailableError(codedError("23505"))).toBe(false);
    expect(isDatabaseUnavailableError(codedError("40001"))).toBe(false);
    expect(isDatabaseUnavailableError(new Error("Quote not found"))).toBe(false);
    expect(isDatabaseUnavailableError("nope")).toBe(false);
  });

  it("detects missing relations as schema not ready", () => {
    expect(isSchemaNotReadyError(codedError("42P01"))).toBe(true);
    expect(isSchemaNotReadyError(codedError("3F000"))).toBe(true);
    expect(isSchemaNotReadyError(codedError("23505"))).toBe(false);
  });

  it("maps failures to sanitized contract categories", () => {
    expect(classifyDatabaseFailure(codedError("28P01"))).toBe("authentication");
    expect(classifyDatabaseFailure(codedError("42501"))).toBe("permission");
    expect(classifyDatabaseFailure(codedError("ETIMEDOUT"))).toBe("timeout");
    expect(classifyDatabaseFailure(new Error("Query read timeout"))).toBe("timeout");
    expect(classifyDatabaseFailure(codedError("ECONNREFUSED"))).toBe("unreachable");
  });
});
