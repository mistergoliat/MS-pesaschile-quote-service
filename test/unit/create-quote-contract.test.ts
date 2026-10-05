/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- contract JSON fixtures and HTTP bodies are untyped by nature */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs, sha256Jcs } from "../../src/application/quote/canonical-json";
import { chargeAmounts, sumTotals } from "../../src/application/quote-v2/arithmetic";
import {
  createQuoteRequestSchema,
  isValidRut,
  toFieldErrors
} from "../../src/application/quote-v2/create-quote-request";

const example = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const createRequest = example("create-and-issue.request.json");

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("normative arithmetic (Domain §6.3) against the frozen examples", () => {
  it("reproduces the domain contract worked example", () => {
    expect(chargeAmounts(24990, "2", "included", "0.19")).toEqual({ net: 42000n, tax: 7980n, gross: 49980n });
    expect(chargeAmounts(89990, "1", "included", "0.19")).toEqual({ net: 75622n, tax: 14368n, gross: 89990n });
    expect(chargeAmounts(5990, "1", "excluded", "0.19")).toEqual({ net: 5990n, tax: 1138n, gross: 7128n });
  });

  it.each(["create-and-issue.response-201.json", "issue.response-200.json", "draft-create.response-201.json"])(
    "recomputes every line, shipping charge and total of %s",
    (name) => {
      const body = example(name) as AnyRecord;
      const quote = (body.quote ?? body) as AnyRecord;
      const charges: Array<{ amounts: ReturnType<typeof chargeAmounts>; basis: "included" | "excluded" | "exempt" }> = [];

      for (const line of quote.lines as AnyRecord[]) {
        const amounts = chargeAmounts(line.unitPrice.amount, line.quantity.value, line.unitPrice.taxBasis, line.unitPrice.taxRate);
        expect({ net: Number(amounts.net), tax: Number(amounts.tax), gross: Number(amounts.gross) }).toEqual(line.amounts);
        charges.push({ amounts, basis: line.unitPrice.taxBasis });
      }

      if (quote.shipping) {
        const s = quote.shipping as AnyRecord;
        const amounts = chargeAmounts(s.amount.amount, "1", s.amount.taxBasis, s.amount.taxRate);
        expect({ net: Number(amounts.net), tax: Number(amounts.tax), gross: Number(amounts.gross) }).toEqual(s.amounts);
        charges.push({ amounts, basis: s.amount.taxBasis });
      }

      const totals = sumTotals(charges);
      expect({ net: Number(totals.net), tax: Number(totals.tax), gross: Number(totals.gross), exemptNet: Number(totals.exemptNet) }).toEqual(
        quote.totals
      );
    }
  );

  it("rounds half up at the charge boundary only", () => {
    // 0.5 peso extensions round up; included net rounds half up.
    expect(chargeAmounts(1, "0.5", "exempt")).toEqual({ net: 1n, tax: 0n, gross: 1n });
    expect(chargeAmounts(1, "0.499999", "exempt")).toEqual({ net: 0n, tax: 0n, gross: 0n });
    expect(chargeAmounts(119, "1", "included", "0.19")).toEqual({ net: 100n, tax: 19n, gross: 119n });
    expect(chargeAmounts(50, "1", "excluded", "0.01")).toEqual({ net: 50n, tax: 1n, gross: 51n }); // 0.5 → 1
    expect(chargeAmounts(1_000_000_000, "9999.999999", "excluded", "1")).toEqual({
      net: 9_999_999_999_000n,
      tax: 9_999_999_999_000n,
      gross: 19_999_999_998_000n
    });
  });
});

describe("closed V2 request schema (openapi CreateQuoteRequest)", () => {
  it.each([
    ["create-and-issue.request.json", (body: AnyRecord) => body],
    ["customer.guest.json", (customer: AnyRecord) => ({ ...createRequest, customer })],
    ["customer.guest-with-contact.json", (customer: AnyRecord) => ({ ...createRequest, customer })],
    ["customer.person.json", (customer: AnyRecord) => ({ ...createRequest, customer })],
    ["customer.company.json", (customer: AnyRecord) => ({ ...createRequest, customer })],
    ["shipping.input.json", (shipping: AnyRecord) => ({ ...createRequest, shipping })]
  ])("accepts the frozen example %s", (name, build) => {
    expect(createQuoteRequestSchema.safeParse(build(example(name))).success).toBe(true);
  });

  const negative = (mutate: (body: AnyRecord) => unknown) => {
    const body = clone(createRequest) as AnyRecord;
    return mutate(body) ?? body;
  };

  // The contract validator's negative set (docs/v2/tools/validate-contract.mjs §4).
  it.each([
    ["exempt with taxRate", (d: AnyRecord) => void (d.lines[0].unitPrice = { amount: 100, taxBasis: "exempt", taxRate: "0.19" })],
    ["included without taxRate", (d: AnyRecord) => void delete d.lines[0].unitPrice.taxRate],
    ["non-canonical quantity 1.50", (d: AnyRecord) => void (d.lines[0].quantity.value = "1.50")],
    ["zero quantity", (d: AnyRecord) => void (d.lines[0].quantity.value = "0")],
    ["float amount", (d: AnyRecord) => void (d.lines[0].unitPrice.amount = 24990.5)],
    ["caller validUntil", (d: AnyRecord) => void (d.validUntil = "2026-10-09T03:00:00Z")],
    ["opportunityId member", (d: AnyRecord) => void (d.opportunityId = "opp-1")],
    ["V1 actor member", (d: AnyRecord) => void (d.actor = { type: "operator", id: "x" })],
    ["reference without type", (d: AnyRecord) => void delete d.externalCorrelation.externalReferenceType],
    ["trace correlationId in externalCorrelation", (d: AnyRecord) => void (d.externalCorrelation.correlationId = "req-1")],
    ["empty lines", (d: AnyRecord) => void (d.lines = [])],
    ["person without displayName", (d: AnyRecord) => void (d.customer = { kind: "person" })],
    ["company without legalName", (d: AnyRecord) => void (d.customer = { kind: "company", tradeName: "X" })],
    ["unknown customer kind", (d: AnyRecord) => void (d.customer = { kind: "anonymous" })],
    ["shipping destination non-CL", (d: AnyRecord) => void (d.shipping.destination.country = "AR")],
    ["shipping as text", (d: AnyRecord) => void (d.shipping = "Despacho Starken")],
    ["tax rate as number", (d: AnyRecord) => void (d.lines[0].unitPrice.taxRate = 0.19)],
    ["rut with dots", (d: AnyRecord) => void (d.customer = { kind: "person", displayName: "A B", rut: "76.123.456-0" })],
    ["rut with wrong check digit", (d: AnyRecord) => void (d.customer = { kind: "person", displayName: "A B", rut: "76123456-1" })],
    ["validity override without reason", (d: AnyRecord) => void (d.validityOverride = { validThroughLocalDate: "2026-10-20" })]
  ])("rejects: %s", (_label, mutate) => {
    expect(createQuoteRequestSchema.safeParse(negative(mutate)).success).toBe(false);
  });

  it("verifies RUT check digits (syntax only)", () => {
    expect(isValidRut("76123456-0")).toBe(true);
    expect(isValidRut("11111111-1")).toBe(true);
    expect(isValidRut("12345678-5")).toBe(true);
    expect(isValidRut("12345678-K")).toBe(false);
    expect(isValidRut("76123456-k")).toBe(false);
  });

  it("reports contract field errors (JSON-pointer path + stable code)", () => {
    const result = createQuoteRequestSchema.safeParse(
      negative((d) => {
        d.opportunityId = "x";
        delete d.lines[0].unitPrice.taxRate;
        d.customer = { kind: "person", displayName: "A B", rut: "76123456-1" };
      })
    );
    const empty = createQuoteRequestSchema.safeParse(negative((d) => void (d.lines = [])));

    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error!)).toEqual(
      expect.arrayContaining([
        { path: "/opportunityId", code: "unknown_member", message: "Unknown member" },
        expect.objectContaining({ path: "/lines/0/unitPrice/taxRate", code: "required" }),
        expect.objectContaining({ path: "/customer/rut", code: "invalid_check_digit" })
      ])
    );
    expect(toFieldErrors(empty.error!)).toEqual([expect.objectContaining({ path: "/lines", code: "lines_required" })]);
  });
});

describe("request fingerprint (Idempotency §2, amendment A3)", () => {
  it("matches the frozen idempotency lookup example for the create example", () => {
    const fingerprint = sha256Jcs({ operation: "quote.create_and_issue", pathParameters: {}, body: createRequest });

    expect(fingerprint).toBe((example("idempotency-lookup.bound.json").binding as AnyRecord).requestFingerprint);
  });

  it("is independent of member order and serializes like RFC 8785", () => {
    const reordered = Object.fromEntries(Object.entries(createRequest).reverse());

    expect(sha256Jcs(reordered)).toBe(sha256Jcs(createRequest));
    // JS objects order integer-like keys first; JCS sorts by UTF-16 code units.
    expect(canonicalizeJcs({ b: 1, "10": [true, null], "9": "x", a: { d: 1.5, c: -0 } })).toBe(
      '{"10":[true,null],"9":"x","a":{"c":0,"d":1.5},"b":1}'
    );
  });
});
