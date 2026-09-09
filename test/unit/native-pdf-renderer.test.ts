import crypto from "node:crypto";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createPdfFixture, createPdfRenderer } from "../../src/scripts/pdf-fixture";

describe("NativePdfRenderer", () => {
  it.each([1, 10, 30, 100])("renders a valid PDF for %i lines", async (itemCount) => {
    const pdf = await createPdfRenderer().renderPdf(createPdfFixture(itemCount));

    expect(pdf.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });

  it("renders the customer-facing snapshot without external identity fields", async () => {
    const pdf = await createPdfRenderer().renderPdf(createPdfFixture(1));
    const output = pdf.toString("latin1");

    expect(output).not.toContain("benchmark-catalog");
    expect(output).not.toContain("external-item-1");
    expect(output).toContain("pdfmake");
  });

  it("renders the shipping line label as Despacho", async () => {
    const fixture = createPdfFixture(1);
    const shippingSnapshot = {
      ...fixture,
      items: [
        {
          ...fixture.items[0]!,
          type: "shipping" as const,
          externalSource: null,
          externalItemId: null,
          externalVariantId: null,
          sku: null,
          description: "Despacho"
        }
      ]
    };
    const pdf = await createPdfRenderer().renderPdf(shippingSnapshot);
    const serialized = pdf.toString("latin1");
    const streams = [...serialized.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((match) => Buffer.from(match[1] ?? "", "latin1"))
      .flatMap((stream) => {
        try {
          return [inflateSync(stream).toString("latin1")];
        } catch {
          return [];
        }
      })
      .join("\n");

    expect(streams).toContain("446573706163686f");
  });

  it("produces a stable hash for the same snapshot", async () => {
    const snapshot = createPdfFixture(10);
    const first = await createPdfRenderer().renderPdf(snapshot);
    const second = await createPdfRenderer().renderPdf(snapshot);

    expect(crypto.createHash("sha256").update(first).digest("hex")).toBe(
      crypto.createHash("sha256").update(second).digest("hex")
    );
  });

  it("does not require a browser for readiness", async () => {
    await expect(createPdfRenderer().checkReadiness()).resolves.toEqual({ status: "up" });
  });
});
