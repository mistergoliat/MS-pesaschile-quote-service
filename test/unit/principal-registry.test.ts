import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generatePrincipalToken,
  PrincipalRegistry,
  PrincipalRegistryError
} from "../../src/infrastructure/auth/principal-registry";
import { bearer, sha256Hex, TEST_TOKENS, testRegistryDocument, testRegistryJson } from "../helpers/test-principals";

type RegistryDocument = ReturnType<typeof testRegistryDocument>;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function inline(document: unknown): PrincipalRegistry {
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}

function loadError(document: unknown): PrincipalRegistryError {
  try {
    inline(document);
  } catch (error) {
    expect(error).toBeInstanceOf(PrincipalRegistryError);
    return error as PrincipalRegistryError;
  }

  throw new Error("expected the registry to be rejected");
}

function mutated(mutate: (document: RegistryDocument) => void): RegistryDocument {
  const document = testRegistryDocument();
  mutate(document);
  return document;
}

describe("PrincipalRegistry authentication", () => {
  const registry = PrincipalRegistry.load({ kind: "inline", json: testRegistryJson() });

  it("A: a valid credential resolves to exactly its principal with explicit scopes", () => {
    const principal = registry.authenticate(bearer(TEST_TOKENS.sales));

    expect(principal?.principalId).toBe("sales-integration");
    expect(principal?.principalType).toBe("service");
    expect([...principal!.scopes].sort()).toEqual(["quotes:create", "quotes:document:read", "quotes:read"]);
    expect(registry.authenticate(bearer(TEST_TOKENS.backoffice))?.principalId).toBe("backoffice");
    // Rotation: a second active token resolves to the same principal.
    expect(registry.authenticate(bearer(TEST_TOKENS.salesRotated))?.principalId).toBe("sales-integration");
    // The scheme is case-insensitive per RFC 7235.
    expect(registry.authenticate(`bearer ${TEST_TOKENS.monitoring}`)?.principalId).toBe("monitoring");
  });

  it.each([
    ["missing header", undefined],
    ["empty header", ""],
    ["unknown token", bearer("x".repeat(64))],
    ["wrong scheme", `Basic ${TEST_TOKENS.sales}`],
    ["token without scheme", TEST_TOKENS.sales],
    ["too short to carry 256 bits", bearer("short-token")],
    ["the hash instead of the token", bearer(sha256Hex(TEST_TOKENS.sales))],
    ["a principal id instead of a token", bearer("sales-integration")],
    ["two tokens", `Bearer ${TEST_TOKENS.sales} ${TEST_TOKENS.backoffice}`],
    ["non-string header", ["Bearer", TEST_TOKENS.sales]]
  ])("B: %s does not authenticate", (_label, header) => {
    expect(registry.authenticate(header)).toBeNull();
  });

  it("the credential material is not the principal id", () => {
    const principal = registry.authenticate(bearer(TEST_TOKENS.sales))!;

    expect(principal.principalId).not.toContain(TEST_TOKENS.sales);
    expect(principal.principalId).not.toBe(sha256Hex(TEST_TOKENS.sales));
  });

  it("a generated token is ≥ 256 bits and authenticates once its hash is registered", () => {
    const { token, tokenSha256 } = generatePrincipalToken();
    const withGenerated = inline(
      mutated((document) => {
        document.principals[0]!.tokenSha256 = [tokenSha256];
      })
    );

    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(withGenerated.authenticate(bearer(token))?.principalId).toBe("monitoring");
    expect(withGenerated.authenticate(bearer(TEST_TOKENS.monitoring))).toBeNull();
  });
});

describe("PrincipalRegistry validation (static startup)", () => {
  it("E: rejects a credential shared by two principals without echoing the hash", () => {
    const shared = sha256Hex(TEST_TOKENS.sales);
    const error = loadError(
      mutated((document) => {
        document.principals[2]!.tokenSha256 = [shared];
      })
    );

    expect(error.issues).toEqual([
      { path: "principals.2.tokenSha256.0", message: "duplicate credential (already assigned to sales-integration)" }
    ]);
    expect(JSON.stringify(error)).not.toContain(shared);
    expect(error.message).not.toContain(shared);
  });

  it("E: rejects the same credential listed twice for one principal", () => {
    const error = loadError(
      mutated((document) => {
        document.principals[0]!.tokenSha256 = [sha256Hex(TEST_TOKENS.monitoring), sha256Hex(TEST_TOKENS.monitoring)];
      })
    );

    expect(error.issues.map((issue) => issue.message)).toEqual(["duplicate credential (already assigned to monitoring)"]);
  });

  it("F: rejects duplicate principal ids", () => {
    const error = loadError(
      mutated((document) => {
        document.principals[2]!.principalId = "sales-integration";
      })
    );

    expect(error.issues).toEqual([
      { path: "principals.2.principalId", message: "duplicate principalId (also at principals.1)" }
    ]);
  });

  it.each([
    ["reserved id system", (d: RegistryDocument) => (d.principals[0]!.principalId = "system"), "principals.0.principalId"],
    ["reserved id legacy-v1", (d: RegistryDocument) => (d.principals[0]!.principalId = "legacy-v1"), "principals.0.principalId"],
    ["non-canonical id", (d: RegistryDocument) => (d.principals[0]!.principalId = "Sales Integration"), "principals.0.principalId"],
    ["unknown scope", (d: RegistryDocument) => (d.principals[0]!.scopes = ["quotes:*"]), "principals.0.scopes.0"],
    ["no scopes", (d: RegistryDocument) => (d.principals[0]!.scopes = []), "principals.0.scopes"],
    ["repeated scope", (d: RegistryDocument) => (d.principals[0]!.scopes = ["quotes:read", "quotes:read"]), "principals.0.scopes"],
    ["unknown principal type", (d: RegistryDocument) => (d.principals[0]!.principalType = "admin"), "principals.0.principalType"],
    ["raw token instead of hash", (d: RegistryDocument) => (d.principals[0]!.tokenSha256 = [TEST_TOKENS.monitoring]), "principals.0.tokenSha256.0"],
    ["three active tokens", (d: RegistryDocument) => (d.principals[1]!.tokenSha256 = [sha256Hex("a"), sha256Hex("b"), sha256Hex("c")]), "principals.1.tokenSha256"],
    ["no token", (d: RegistryDocument) => (d.principals[0]!.tokenSha256 = []), "principals.0.tokenSha256"],
    ["unknown member", (d: RegistryDocument) => Object.assign(d.principals[0]!, { isAdmin: true }), "principals.0"],
    ["no principals", (d: RegistryDocument) => (d.principals = []), "principals"],
    ["wrong version", (d: RegistryDocument) => Object.assign(d, { version: 2 }), "version"]
  ])("rejects a malformed registry: %s", (_label, mutate, issuePath) => {
    const error = loadError(mutated(mutate));

    expect(error.issues.map((issue) => issue.path)).toContain(issuePath);
  });

  it("rejects invalid JSON without echoing the document", () => {
    const secretLooking = sha256Hex("do-not-echo");

    expect(() => PrincipalRegistry.load({ kind: "inline", json: `{"principals": ["${secretLooking}"` })).toThrow(
      new PrincipalRegistryError("Principal registry is not valid JSON")
    );
  });

  it("rejects an unreadable registry file", () => {
    expect(() =>
      PrincipalRegistry.load({ kind: "file", path: path.join(os.tmpdir(), "missing-quote-registry.json") })
    ).toThrow(PrincipalRegistryError);
  });
});

describe("PrincipalRegistry reload (rotation without restart)", () => {
  function fileRegistry(document: unknown) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quote-registry-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "principals.json");
    fs.writeFileSync(file, JSON.stringify(document));
    return { file, registry: PrincipalRegistry.load({ kind: "file", path: file }) };
  }

  it("rotates and revokes credentials from the file", () => {
    const { file, registry } = fileRegistry(testRegistryDocument());
    const { token, tokenSha256 } = generatePrincipalToken();

    fs.writeFileSync(
      file,
      JSON.stringify(
        mutated((document) => {
          document.principals[1]!.tokenSha256 = [tokenSha256];
        })
      )
    );

    expect(registry.reload()).toEqual({ ok: true, principals: 5 });
    expect(registry.authenticate(bearer(token))?.principalId).toBe("sales-integration");
    expect(registry.authenticate(bearer(TEST_TOKENS.sales))).toBeNull();
  });

  it("keeps the current registry when the new one is invalid", () => {
    const { file, registry } = fileRegistry(testRegistryDocument());
    fs.writeFileSync(file, "{ not json");

    const result = registry.reload();

    expect(result.ok).toBe(false);
    expect(registry.authenticate(bearer(TEST_TOKENS.sales))?.principalId).toBe("sales-integration");
  });
});
