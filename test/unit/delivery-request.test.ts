import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  emailDeliveryRequestSchema,
  isSingleMailbox,
  mailbox,
  maskRecipient,
  resolveRecipient
} from "../../src/application/quote-v2/delivery/delivery-request";
import { HOSTILE_RECIPIENTS } from "../helpers/hostile-recipients";

const example = (name: string): unknown => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8"));


describe("delivery recipient: strict single mailbox", () => {
  it("accepts ordinary addresses, including the contract examples", () => {
    for (const value of ["camila.rojas@example.com", "compras@andesfit.example.com", "o'brien+quotes@example.cl", "A@B.CL", "ab@ex.co"]) {
      expect(mailbox.safeParse(value).success, value).toBe(true);
    }

    expect(emailDeliveryRequestSchema.safeParse(example("email-delivery.request.json")).success).toBe(true);
    expect(emailDeliveryRequestSchema.safeParse({}).success).toBe(true);
  });

  it("rejects every injection / multi-recipient / malformed payload", () => {
    for (const value of HOSTILE_RECIPIENTS) {
      expect(mailbox.safeParse(value).success, JSON.stringify(value)).toBe(false);
      expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: value } }).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("the deny-list guard rejects list, quoting, grouping and control syntax on its own", () => {
    for (const value of ["a>,<victim@evil.com", "a;b@c.com", "a:b@c.com", 'a"b@c.com', "a(b)@c.com", "a[b]@c.com", "a\\b@c.com", "a b@c.com", "a\r@b.com", "a@b@c.com"]) {
      expect(isSingleMailbox(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("the request schema is closed and the name is contract Text (≤ 200)", () => {
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: "a@b.cl" }, cc: "x@y.cl" }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: "a@b.cl", bcc: "x@y.cl" } }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { name: "No Address" } }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: "a@b.cl", name: "x".repeat(201) } }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: "a@b.cl", name: "Ana\r\nBcc: x@y.cl" } }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: { email: "a@b.cl", name: " padded" } }).success).toBe(false);
    expect(emailDeliveryRequestSchema.safeParse({ recipient: null }).success).toBe(false);
  });
});

describe("recipient resolution (Domain §10.2)", () => {
  const person = { kind: "person", displayName: "Camila Rojas", email: "camila.rojas@example.com" };
  const company = { kind: "company", legalName: "Gimnasio Andes SpA", contactName: "Pedro Soto", email: "compras@andesfit.example.com" };

  it("explicit recipient wins, with its own name only (never the customer's)", () => {
    expect(resolveRecipient({ recipient: { email: "other@example.com", name: "Otra Persona" } }, person)).toEqual({
      email: "other@example.com",
      name: "Otra Persona",
      source: "request"
    });
    expect(resolveRecipient({ recipient: { email: "other@example.com" } }, person)).toEqual({ email: "other@example.com", name: null, source: "request" });
  });

  it("falls back to the frozen customer email and that customer's person name", () => {
    expect(resolveRecipient({}, person)).toEqual({ email: "camila.rojas@example.com", name: "Camila Rojas", source: "customer" });
    expect(resolveRecipient({}, company)).toEqual({ email: "compras@andesfit.example.com", name: "Pedro Soto", source: "customer" });
    expect(resolveRecipient({}, { kind: "company", legalName: "Sin Contacto SpA", email: "x@y.cl" })).toEqual({ email: "x@y.cl", name: null, source: "customer" });
    expect(resolveRecipient({}, { kind: "guest", email: "guest@y.cl" })).toEqual({ email: "guest@y.cl", name: null, source: "customer" });
  });

  it("no address anywhere, or an unusable stored one → null (422 delivery_recipient_missing)", () => {
    expect(resolveRecipient({}, { kind: "guest" })).toBeNull();
    expect(resolveRecipient({}, { kind: "person", displayName: "Sin Email" })).toBeNull();
    expect(resolveRecipient({}, { kind: "guest", email: "a>,<victim@evil.com" })).toBeNull();
    expect(resolveRecipient({}, { kind: "guest", email: 42 })).toBeNull();
  });
});

describe("recipient masking (openapi Delivery.recipientMasked)", () => {
  it("matches the contract example exactly", () => {
    expect(maskRecipient("camila.rojas@example.com")).toBe((example("delivery.response.json") as { recipientMasked: string }).recipientMasked);
  });

  it("is deterministic and never returns a short local part whole", () => {
    expect(maskRecipient("abc@ex.cl")).toBe("ab***@ex.cl");
    expect(maskRecipient("ab@ex.cl")).toBe("a***@ex.cl");
    expect(maskRecipient("a@ex.cl")).toBe("a***@ex.cl");
    expect(maskRecipient("ab@ex.cl")).toBe(maskRecipient("ab@ex.cl"));
  });

  it("stays within 254 characters (column and contract bound)", () => {
    const longDomain = `${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(63)}.${"g".repeat(57)}.cl`;
    const email = `a@${longDomain}`;
    expect(email.length).toBeLessThanOrEqual(254);
    expect(maskRecipient(email).length).toBeLessThanOrEqual(254);
    expect(maskRecipient(email)).toBe("a***@***");
  });

  it("contains no more of the address than two local characters and the domain", () => {
    const masked = maskRecipient("camila.rojas@example.com");
    expect(masked).not.toContain("camila");
    expect(masked).not.toContain("rojas");
  });
});
