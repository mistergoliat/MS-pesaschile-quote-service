import crypto from "node:crypto";

/**
 * Test-only principals, shaped like the contract's example deployment
 * profiles (security contract §5). Tokens are fixed so tests are
 * deterministic; they are only ever valid against this test registry.
 */
export const TEST_TOKENS = {
  monitoring: "test-monitoring-token-0123456789abcdefghijklmnopqrstuv",
  sales: "test-sales-integration-token-0123456789abcdefghijklmnopq",
  salesRotated: "test-sales-integration-rotated-0123456789abcdefghijklmn",
  backoffice: "test-backoffice-operator-token-0123456789abcdefghijklmn",
  supervisor: "test-commercial-supervisor-token-0123456789abcdefghijkl",
  pricingDesk: "test-pricing-desk-override-token-0123456789abcdefghijk"
} as const;

export const sha256Hex = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export const bearer = (token: string): string => `Bearer ${token}`;

export function testRegistryDocument() {
  return {
    version: 1,
    principals: [
      {
        principalId: "monitoring",
        principalType: "service",
        scopes: ["service:health:dependencies", "quotes:read", "quotes:read:any", "quotes:audit:read"],
        tokenSha256: [sha256Hex(TEST_TOKENS.monitoring)]
      },
      {
        principalId: "sales-integration",
        principalType: "service",
        scopes: ["quotes:create", "quotes:read", "quotes:document:read"],
        tokenSha256: [sha256Hex(TEST_TOKENS.sales), sha256Hex(TEST_TOKENS.salesRotated)]
      },
      {
        principalId: "backoffice",
        principalType: "operator",
        scopes: [
          "quotes:draft:write",
          "quotes:issue",
          "quotes:read",
          "quotes:read:any",
          "quotes:document:read",
          "quotes:cancel",
          "quotes:audit:read"
        ],
        tokenSha256: [sha256Hex(TEST_TOKENS.backoffice)]
      },
      {
        principalId: "supervisor",
        principalType: "operator",
        scopes: [
          "quotes:draft:write",
          "quotes:issue",
          "quotes:read",
          "quotes:read:any",
          "quotes:document:read",
          "quotes:cancel",
          "quotes:audit:read",
          "quotes:validity:override"
        ],
        tokenSha256: [sha256Hex(TEST_TOKENS.supervisor)]
      },
      {
        // Transactional caller explicitly approved for validity overrides.
        principalId: "pricing-desk",
        principalType: "service",
        scopes: ["quotes:create", "quotes:read", "quotes:validity:override"],
        tokenSha256: [sha256Hex(TEST_TOKENS.pricingDesk)]
      }
    ]
  };
}

export const testRegistryJson = (): string => JSON.stringify(testRegistryDocument());
