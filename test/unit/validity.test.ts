import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  addDays,
  civilDate,
  OverrideOutOfRangeError,
  resolveValidity,
  startOfLocalDate,
  VALIDITY_POLICY_ID
} from "../../src/application/quote-v2/validity";

// The frozen worked examples, read from the contract itself (not re-typed).
const policyDoc = fs.readFileSync(path.resolve("docs/v2/QUOTE_V2_VALIDITY_POLICY.md"), "utf8");
const examples = [...policyDoc.matchAll(/^\| (E\d) \| ([0-9TZ:-]+) \| [^|]+\| ([0-9-]+) \| ([0-9-]+) \| ([0-9TZ:-]+) \|/gm)].map(
  ([, id, issuedAt, issueLocalDate, validThroughLocalDate, validUntilExclusive]) => ({
    id: id!,
    issuedAt: issuedAt!,
    issueLocalDate: issueLocalDate!,
    validThroughLocalDate: validThroughLocalDate!,
    validUntilExclusive: validUntilExclusive!
  })
);

describe("validity policy cl-retail-5-calendar-days-v1", () => {
  it("reads all seven frozen worked examples", () => {
    expect(examples.map((example) => example.id)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
  });

  it.each(examples)("$id: issued $issuedAt → through $validThroughLocalDate, until $validUntilExclusive", (example) => {
    const validity = resolveValidity(Date.parse(example.issuedAt));

    expect(validity).toMatchObject({
      source: "policy",
      policyId: VALIDITY_POLICY_ID,
      issuerZone: "America/Santiago",
      issueLocalDate: example.issueLocalDate,
      validThroughLocalDate: example.validThroughLocalDate,
      override: null
    });
    expect(Date.parse(validity.validUntilExclusive)).toBe(Date.parse(example.validUntilExclusive));
    expect(validity.tzdbVersion).toMatch(/^[0-9]{4}[a-z]$/);
  });

  it("is never a multiple of 24 h and the boundary is the first instant of its local date", () => {
    // Every hour across 2026–2027, which includes all four Chile transitions.
    for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += 3_600_000) {
      const validity = resolveValidity(t);
      const boundary = Date.parse(validity.validUntilExclusive);
      const elapsedHours = (boundary - t) / 3_600_000;

      expect(elapsedHours).toBeGreaterThan(95);
      expect(elapsedHours).toBeLessThanOrEqual(121);
      expect(civilDate(boundary)).toBe(addDays(validity.validThroughLocalDate, 1));
      expect(civilDate(boundary - 1)).toBe(validity.validThroughLocalDate);
    }
    // Exhaustive correctness sweep (~17,500 resolutions, ~4 s): not a performance assertion.
  }, 15_000);

  it.each([
    ["2026-04-05", "April transition 2026 (repeated 23:00 hour)"],
    ["2026-09-06", "September transition 2026 (skipped midnight)"],
    ["2027-04-04", "April transition 2027"],
    ["2027-09-05", "September transition 2027"]
  ])("resolves the start of %s (%s) to its earliest instant", (localDate) => {
    const start = startOfLocalDate(localDate);

    expect(civilDate(start)).toBe(localDate);
    expect(civilDate(start - 1)).toBe(addDays(localDate, -1));
  });

  it("does not depend on the server time zone (TZ)", () => {
    const script = `import { resolveValidity } from "./src/application/quote-v2/validity.ts";
      process.stdout.write(JSON.stringify(resolveValidity(Date.parse("2027-08-31T16:00:00Z"))));`;
    const outputs = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((tz) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8"
      });
      expect(result.status).toBe(0);
      return result.stdout;
    });

    expect(new Set(outputs).size).toBe(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ validUntilExclusive: "2027-09-05T04:00:00Z" });
  });
});

describe("privileged validity override", () => {
  const issuedAt = Date.parse("2026-10-04T18:00:00Z"); // issueLocalDate 2026-10-04

  it("freezes source override, no policy id, the overriding principal and reason", () => {
    expect(
      resolveValidity(issuedAt, { validThroughLocalDate: "2026-10-20", reasonCode: "campaign_hold", principalId: "supervisor" })
    ).toMatchObject({
      source: "override",
      policyId: null,
      validThroughLocalDate: "2026-10-20",
      validUntilExclusive: "2026-10-21T03:00:00Z",
      override: { principalId: "supervisor", reasonCode: "campaign_hold" }
    });
  });

  it.each([
    ["2026-10-04", true],
    ["2027-10-04", true],
    ["2026-10-03", false],
    ["2027-10-05", false]
  ])("accepts issueLocalDate … +365 days only: %s → %s", (validThroughLocalDate, accepted) => {
    const resolve = () => resolveValidity(issuedAt, { validThroughLocalDate, reasonCode: "x_reason", principalId: "supervisor" });

    if (accepted) {
      expect(resolve().validThroughLocalDate).toBe(validThroughLocalDate);
    } else {
      expect(resolve).toThrow(OverrideOutOfRangeError);
    }
  });
});
