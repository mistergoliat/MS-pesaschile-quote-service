import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { issuedSnapshotHash } from "../../src/application/quote-v2/issued-snapshot";
import {
  buildIssuedSnapshot,
  QuoteNotAcceptedError,
  type IssuedSnapshotRows
} from "../../src/infrastructure/persistence/postgres/issued-snapshot-loader";
import { DIRECT_CREATE, DRAFT_ISSUE, GUEST_MINIMAL_SHIPPING, type IssuedSnapshotFixture } from "../fixtures/issued-snapshot-rows";

/**
 * Recorded at 387b798 (before R1.5B1) by feeding the fixture rows through the
 * R1.5A derivation (readQuote projection → semanticSnapshotHash). If one of
 * these fails, an accepted quote would no longer verify: investigate, never
 * update the constant.
 */
const GOLDEN = {
  DIRECT_CREATE: "2568fa2b908ef2f4938d32af0ce8a40e9df2710ff5d9b136bd71888e306c990b",
  DRAFT_ISSUE: "5e2240a9bc2c0661d7d100d3a74b3e5563722b2918a49c417f263cc17964893f",
  GUEST_MINIMAL_SHIPPING: "972c841b7297dce1dfaeb193286635757dd0488dd185dda1963fb67e409f9d06"
};

const rows = (fixture: IssuedSnapshotFixture) => fixture as unknown as IssuedSnapshotRows;

describe("issued snapshot hash (jcs-sha256-v2)", () => {
  it("AN: reproduces the golden hash of a direct create-and-issue snapshot", () => {
    expect(issuedSnapshotHash(buildIssuedSnapshot(rows(DIRECT_CREATE)))).toBe(GOLDEN.DIRECT_CREATE);
  });

  it("AO: reproduces the golden hash of an issued draft (company, exempt + fractional lines, override, no shipping)", () => {
    expect(issuedSnapshotHash(buildIssuedSnapshot(rows(DRAFT_ISSUE)))).toBe(GOLDEN.DRAFT_ISSUE);
  });

  it("reproduces the golden hash of a guest quote with minimal exempt shipping", () => {
    expect(issuedSnapshotHash(buildIssuedSnapshot(rows(GUEST_MINIMAL_SHIPPING)))).toBe(GOLDEN.GUEST_MINIMAL_SHIPPING);
  });

  it("is sensitive to every frozen member and blind to everything else", () => {
    const base = buildIssuedSnapshot(rows(DIRECT_CREATE));
    const hash = issuedSnapshotHash(base);

    expect(issuedSnapshotHash({ ...base, quoteNumber: "PC-000999" })).not.toBe(hash);
    expect(issuedSnapshotHash({ ...base, totals: { ...base.totals, gross: base.totals.gross + 1 } })).not.toBe(hash);
    expect(issuedSnapshotHash({ ...base, lines: base.lines.slice(0, 1) })).not.toBe(hash);
    // Extra members (e.g. a future status or document field) never enter the hash.
    expect(issuedSnapshotHash({ ...base, status: "issued", document: { available: true } } as typeof base)).toBe(hash);
  });

  it("omits absent optional members instead of writing null (JCS distinguishes them)", () => {
    const snapshot = buildIssuedSnapshot(rows(GUEST_MINIMAL_SHIPPING));

    expect(snapshot.shipping).toEqual({
      carrier: { name: "Retiro coordinado" },
      destination: { commune: "Santiago", country: "CL" },
      amount: { amount: 5000, taxBasis: "exempt" },
      amounts: { net: 5000, tax: 0, gross: 5000 }
    });
    expect(snapshot.lines[0]).toEqual({
      lineId: "b0617283-94a5-4fb6-a0c7-e8f90a1b2c34",
      position: 1,
      kind: "product",
      item: { sourceSystem: "pesaschile-catalog", productRef: "77", sku: "KB-8", description: "Kettlebell 8 kg" },
      quantity: { value: "0.25", unit: "unit" },
      unitPrice: { amount: 40000, taxBasis: "included", taxRate: "0.19" },
      pricingProvenance: { sourceSystem: "pesaschile-catalog", asOf: "2026-10-04T12:00:00Z" },
      amounts: { net: 8403, tax: 1597, gross: 10000 }
    });
    expect(buildIssuedSnapshot(rows(DRAFT_ISSUE)).validity).toEqual({
      source: "override",
      policyId: null,
      issuerZone: "America/Santiago",
      tzdbVersion: "2025b",
      issueLocalDate: "2026-10-04",
      validThroughLocalDate: "2026-10-20",
      validUntilExclusive: "2026-10-21T03:00:00Z",
      override: { principalId: "supervisor", reasonCode: "customer_requested_extension" }
    });
  });

  it("refuses a quote that was never accepted for issue", () => {
    expect(() => buildIssuedSnapshot(rows({ ...DIRECT_CREATE, quote: { ...DIRECT_CREATE.quote, quote_number: null } }))).toThrow(
      QuoteNotAcceptedError
    );
  });
});

/** Relative-import closure of a source file (TypeScript sources only). */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [path.resolve(entry)];

  while (pending.length > 0) {
    const file = pending.pop()!;

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    const source = fs.readFileSync(file, "utf8");

    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      pending.push(path.resolve(path.dirname(file), `${match[1]}.ts`));
    }
  }

  return seen;
}

const relative = (files: Set<string>) => [...files].map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/")).sort();

describe("issued snapshot ownership", () => {
  it("AQ: the snapshot module and its loader cannot reach the public read projection", () => {
    const closure = relative(
      new Set([
        ...importClosure("src/application/quote-v2/issued-snapshot.ts"),
        ...importClosure("src/infrastructure/persistence/postgres/issued-snapshot-loader.ts")
      ])
    );

    expect(closure).not.toContain("src/infrastructure/persistence/postgres/quote-v2-reads.ts");
    expect(closure).toEqual([
      "src/application/quote-v2/issued-snapshot.ts",
      "src/application/quote/canonical-json.ts",
      "src/infrastructure/config/env.ts",
      "src/infrastructure/persistence/postgres/issued-snapshot-loader.ts",
      "src/infrastructure/persistence/postgres/postgres.ts"
    ]);
  });

  it("AS: the snapshot and worker modules import no network or external-service client", () => {
    const closure = new Set([
      ...importClosure("src/infrastructure/persistence/postgres/issued-snapshot-loader.ts"),
      ...importClosure("src/application/quote-v2/issuance-worker.ts"),
      ...importClosure("src/infrastructure/persistence/postgres/issuance-operations.ts")
    ]);

    for (const file of closure) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+"(node:)?(http|https|net|dns|undici)"|\bfetch\(|email-sender|\/email\//);
    }
  });

  it("acceptance and the worker hash through the same module", () => {
    const acceptance = fs.readFileSync("src/infrastructure/persistence/postgres/quote-v2-acceptance.ts", "utf8");

    expect(acceptance).toContain("issuedSnapshotHash(await loadIssuedSnapshot(client, quoteId))");
    expect(acceptance).not.toMatch(/sha256Jcs\(\{\s*quoteId/);
  });
});
