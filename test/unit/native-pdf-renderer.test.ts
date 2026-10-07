import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { buildIssuedQuoteDocumentModelV2, type IssuedQuoteDocumentModelV2 } from "../../src/application/quote-v2/document/issued-quote-document-model";
import { DocumentRenderError } from "../../src/application/quote-v2/document/pdf-renderer-port";
import type { IssuedSnapshot } from "../../src/application/quote-v2/issued-snapshot";
import { buildDocumentDefinition, NativePdfRenderer } from "../../src/infrastructure/documents/native-pdf-renderer";
import {
  installedPackageVersion,
  RENDERER_PROFILE,
  RENDERER_VERSION,
  rendererRuntimeMismatches
} from "../../src/infrastructure/documents/renderer-profile";
import { createIssuedSnapshotFixture, createLinesFixture, createMixedTaxFixture, goldenPdfFixtures, productionPdfFixtures } from "../../src/scripts/pdf-fixture";
import { PESASCHILE_CL_V2 } from "../../src/application/quote-v2/document/issuer-profiles";
import { importClosure } from "../helpers/import-closure";
import { compact, extractPdfText, pdfInfo } from "../helpers/pdf-text";

/**
 * Golden formal-PDF hashes (template v4, RENDERER_VERSION below). Recorded on
 * Windows (Node 24.14.0) and reproduced byte-for-byte in the Linux runtime
 * image (node:24.14.0-bookworm-slim) with `npm run pdf:determinism:runtime`.
 * A mismatch means the bytes changed: bump the template or renderer version
 * deliberately; never just update a value to make the test pass.
 */
const GOLDEN_PDF_SHA256: Record<string, string> = {
  "person-shipping-included": "04e17eaee34526614d2096a9fc7332885c7fa8849a5a2e2ec1237e6483c3da48",
  "company-mixed-tax": "f169860f65c1b018d80978c198b14fc1309724905088bc916aef33ecc1d5e36d",
  "guest-no-data-no-shipping": "41d537ae6c1b34b0e60c2bfc0fcb3657229b297fbee23eb8ad3fd19a8975cef4",
  "guest-with-contact": "2aa47726de67171485c56486a1e13ef3c18b06b01fe89dc78e61e81979866821",
  "long-descriptions": "83d742229886e25ca64a24f57c527dd5675cbb67f381ee361aca5b3c2f795cfc",
  "hundred-lines": "6e331d13afa266e843fec3eef31c66085f9a16310712125302fa5902295e702f",
  "unicode-latin-extended": "bb37935bb60ee3da7470d821670117230b02852f5b6075990dfeca2e431c5028"
};

/** R1.7A NEW production identity v2 / template v5, Node 24.14.0.
 * Archived GOLDEN_PDF_SHA256 above is preserved, not refreshed.
 */
const PRODUCTION_GOLDEN_PDF_SHA256: Record<string, string> = {
  "person-shipping-included": "18e101e656f2330c09afd346beed350cfbf09182b20a82ed8f0f1884b7fc5bcd",
  "company-mixed-tax": "0d9a64e586ef4ce46a3d2d8cba3a1013d751f76ca6ada4ebad9b686b47af2a9b",
  "guest-no-data-no-shipping": "1552625abae77ada8bd2a6748ca6c7b69c0bb2dd2c647ebc051f92966ae976f0",
  "guest-with-contact": "19f3d6d4ac49d83163f53fc7b163b25ab9932d0972218732d027e87866cb3173",
  "long-descriptions": "20a7ecbe39791404e72601c3f32875c87d6818d7a511bb6913b44659dbaeb7d1",
  "hundred-lines": "c149ecf556dba674206b4de8c08c95f215b4d4d3f92607feede90fffd6e8aeda",
  "unicode-latin-extended": "88e1a630826435eab89bcbeb82be628e17bd6d1c2b5b8d9deaa4e633ed4b5b19",
  "excluded-no-shipping": "d0ec7614c28a650328f53734ff4e60aba824ae0ffac47b49f5c6a15fd554213f",
  "exempt-no-shipping": "55d13f7775876937a003e617d1252ce58522321918c44ad7e770ca977bcb2c87"
};

const renderer = new NativePdfRenderer();
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const render = (snapshot: IssuedSnapshot) => renderer.renderPdf(buildIssuedQuoteDocumentModelV2(snapshot));
const VAT = { taxBasis: "included", taxRate: "0.19" } as const;
const withText = (description: string, customer: Record<string, unknown> = { kind: "person", displayName: "Camila Rojas" }) =>
  createIssuedSnapshotFixture({ customer, lines: [{ description, sku: "SKU-1", price: { amount: 9_990, ...VAT } }] });

async function renderError(snapshot: IssuedSnapshot): Promise<DocumentRenderError> {
  const error: unknown = await render(snapshot).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(DocumentRenderError);
  return error as DocumentRenderError;
}

describe("formal PDF: content survives rendering (text extraction)", () => {
  it.each(productionPdfFixtures())("R1.7A %s: approved identity, tax presentation and frozen totals survive the PDF", async (_name, snapshot) => {
    const model = buildIssuedQuoteDocumentModelV2(snapshot);
    const pdf = await render(snapshot);
    const text = compact(await extractPdfText(pdf));
    for (const expected of [PESASCHILE_CL_V2.legalName, `RUT: ${PESASCHILE_CL_V2.rut}`, PESASCHILE_CL_V2.address!, PESASCHILE_CL_V2.website!, model.validityStatement, model.totals.net, model.totals.tax, model.totals.gross, ...model.lines.map((line) => line.taxBasis)]) {
      expect(text).toContain(compact(expected));
    }
    expect(text).not.toContain("Datostributariosdelemisorpendientesdeaprobación");
    expect(text.includes("ValoresconIVAincluido.")).toBe(model.taxStatement !== null);
    expect(pdf.toString("latin1").match(/\/Subtype\s*\/Image/g)?.length).toBe(2);
    expect(model.templateVersion).toBe("quote-pdf-template-v5");
  });
  it("renders every section of the model and nothing internal", async () => {
    const text = compact(await extractPdfText(await render(createMixedTaxFixture())));

    for (const expected of [
      "COTIZACIÓN",
      "PC-000138",
      "Fechadeemisión:04/10/2026",
      "Válidahastael09/10/2026inclusive(horadeChile)",
      "PesasChileSPA",
      "Datostributariosdelemisorpendientesdeaprobación",
      "GimnasioAndesSpA",
      "Nombredefantasía:AndesFit",
      "RUT:76123456-0",
      "Cauchodepiso1m²",
      "1,5m²",
      "$67.667",
      "Neto+IVA19%",
      "ExentodeIVA",
      "Transportista:PCCarrier",
      "Netoexento",
      "Página1de1"
    ]) {
      expect(text, expected).toContain(expected);
    }

    expect(text).not.toContain("ValoresconIVAincluido");
    expect(text).not.toMatch(/fixture-|0f8e4a52|00000000-0000|Bastian|Servicio al Cliente/);
  });

  it.each([
    ["R", "Ñandú Peñalolén áéíóú ÁÉÍÓÚ ü"],
    ["S", "Łódź"],
    ["T", "Ős"],
    ["U", "≤ 50 cm ≥ 10 cm → ✓ ✔ € № ½ «»"],
    ["W (supported emoji)", "Entrega 😀 ❤"],
    ["Greek/Cyrillic", "Ωμέγα Жук"]
  ])("%s: %s is extracted exactly as given", async (_id, value) => {
    const text = compact(await extractPdfText(await render(withText(value, { kind: "person", displayName: value }))));

    // Once in the customer block (regular/bold face) and once in the line description.
    expect(text.split(compact(value)).length - 1).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["V (CJK)", "漢字", ["U+5B57", "U+6F22"]],
    ["V (Hangul)", "가", ["U+AC00"]],
    ["W (unsupported emoji)", "Listo 👍🔥", ["U+1F44D", "U+1F525"]]
  ])("%s: %s is rejected as unsupported_glyph, never drawn as .notdef", async (_id, value, codePoints) => {
    for (const snapshot of [withText(`Producto ${value}`), withText("Producto", { kind: "company", legalName: `Empresa ${value}` })]) {
      const error = await renderError(snapshot);

      expect(error).toMatchObject({ code: "document_generation_failed", reason: "unsupported_glyph", codePoints });
      // X: never a silently corrupted PDF, and no snapshot text in the error.
      expect(`${error.message} ${error.stack ?? ""}`).not.toContain(value);
    }
  });
});

describe("formal PDF: determinism", () => {
  it("golden fixtures render to their pinned SHA-256", async () => {
    const actual: Record<string, string> = {};

    for (const [name, snapshot] of goldenPdfFixtures()) {
      actual[name] = sha256(await render(snapshot));
    }

    expect(actual).toEqual(GOLDEN_PDF_SHA256);
  });

  it("R1.7A production fixtures render to NEW pinned hashes, repeatedly and with fresh renderers", async () => {
    const actual: Record<string, string> = {};
    for (const [name, snapshot] of productionPdfFixtures()) {
      const model = buildIssuedQuoteDocumentModelV2(snapshot);
      const first = await renderer.renderPdf(model);
      const repeated = await renderer.renderPdf(model);
      const fresh = await new NativePdfRenderer().renderPdf(model);
      expect(first.equals(repeated)).toBe(true);
      expect(first.equals(fresh)).toBe(true);
      actual[name] = sha256(first);
    }
    expect(actual).toEqual(PRODUCTION_GOLDEN_PDF_SHA256);
  });

  it("Y/Z: same model → same bytes: repeated, fresh vs reused renderer, concurrent calls", async () => {
    const model = buildIssuedQuoteDocumentModelV2(createLinesFixture(30));
    const reused = await Promise.all([renderer.renderPdf(model), renderer.renderPdf(model)]);
    const fresh = await new NativePdfRenderer().renderPdf(model);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => renderer.renderPdf(model)));

    expect(new Set([...reused, fresh, ...concurrent].map(sha256)).size).toBe(1);
  });

  it("AA/AB: separate processes under different TZ and LANG produce the golden bytes", () => {
    for (const env of [
      { TZ: "UTC", LANG: "C" },
      { TZ: "Asia/Tokyo", LANG: "ja_JP.UTF-8" },
      { TZ: "America/Santiago", LANG: "es_CL.UTF-8" },
      { TZ: "Pacific/Kiritimati", LANG: "tr_TR.UTF-8" }
    ]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/pdf-determinism.ts"], {
        env: { ...process.env, ...env, LC_ALL: env.LANG },
        encoding: "utf8",
        timeout: 60_000
      });

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as { tz: string; hashes: Record<string, string>; productionHashes: Record<string, string> };
      expect(output.tz).toBe(env.TZ);
      expect(output.hashes).toEqual(GOLDEN_PDF_SHA256);
      expect(output.productionHashes).toEqual(PRODUCTION_GOLDEN_PDF_SHA256);
    }
  }, 240_000);

  it("AD/AE: issuedAt and quoteNumber are part of the bytes", async () => {
    const base = createLinesFixture(1);
    const hash = sha256(await render(base));

    expect(sha256(await render({ ...base, issuedAt: "2026-10-04T18:00:01Z" }))).not.toBe(hash);
    expect(sha256(await render({ ...base, quoteNumber: "PC-000999" }))).not.toBe(hash);
  });

  it("metadata is a function of the model: CreationDate = issuedAt, no ModDate, producer = rendererVersion", async () => {
    const pdf = await render(createLinesFixture(1));
    const { info } = await pdfInfo(pdf);

    expect(info).toMatchObject({
      Title: "Cotización PC-900001",
      Author: "Pesas Chile SPA",
      Subject: "Cotización comercial",
      Creator: "PesasChile Quote Service",
      Producer: RENDERER_VERSION,
      CreationDate: "D:20261004180000Z"
    });
    expect(info).not.toHaveProperty("ModDate");
    expect(pdf.toString("latin1")).not.toMatch(/\/ModDate/);
  });
});

describe("formal PDF: renderer version and pinned stack (AF)", () => {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string }> };

  it("the profile matches the lockfile, the installed packages and the running Node/zlib", () => {
    for (const [name, version] of Object.entries(RENDERER_PROFILE.packages)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
      expect(installedPackageVersion(name), name).toBe(version);
    }

    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; engines: { node: string } };
    expect(pkg.dependencies.pdfmake).toBe(RENDERER_PROFILE.packages.pdfmake);
    expect(pkg.engines.node).toBe(`>=${RENDERER_PROFILE.nodeMajor}.0.0 <${RENDERER_PROFILE.nodeMajor + 1}`);
    expect(Number(process.versions.node.split(".")[0])).toBe(RENDERER_PROFILE.nodeMajor);
    expect(process.versions.zlib).toBe(RENDERER_PROFILE.zlib);
    expect(rendererRuntimeMismatches()).toEqual([]);
    expect(fs.readFileSync("Dockerfile", "utf8")).toMatch(new RegExp(`FROM node:${RENDERER_PROFILE.nodeMajor}\\.\\d+\\.\\d+-`));
  });

  it("pins the embedded font files by hash and names every component in the version label", () => {
    for (const face of Object.values(RENDERER_PROFILE.fonts)) {
      expect(sha256(fs.readFileSync(path.join("src/infrastructure/documents/assets/fonts", face.file)))).toBe(face.sha256);
    }

    expect(RENDERER_VERSION).toBe("quote-pdf-r4+pdfmake-0.2.20+pdfkit-0.15.3+node24+zlib-1.3.1-e00f703+dejavu-sans-2.37");
    expect(RENDERER_VERSION.length).toBeLessThanOrEqual(100);
    expect(renderer.rendererVersion).toBe(RENDERER_VERSION);
  });

  it("detects a running stack that differs from the profile", () => {
    expect(rendererRuntimeMismatches({ ...process.versions, node: "20.19.0", zlib: "1.3.0.1-motley" })).toEqual(["node", "zlib"]);
  });
});

describe("formal PDF: security of the pdfmake input", () => {
  const RESOURCE_KEYS = new Set(["image", "images", "svg", "link", "linkToPage", "linkToDestination", "font", "attachment", "attachments", "files", "qr", "url", "watermark"]);
  const hostile: readonly string[] = [
    "<script>alert('x')</script><b>negrita</b>",
    "issuerLogo",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
    "https://evil.example/collect?q=1",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "QuoteSans"
  ];
  const hostileSnapshot = () =>
    createIssuedSnapshotFixture({
      customer: { kind: "company", legalName: hostile[0], tradeName: hostile[1], contactName: hostile[2], email: hostile[3], address: { lines: [hostile[4]], country: "CL" } },
      lines: hostile.map((description, index) => ({
        description,
        sku: hostile[(index + 1) % hostile.length]!,
        attributes: [{ name: hostile[5]!, value: hostile[3]! }],
        price: { amount: 1_000, ...VAT }
      })),
      shipping: { carrierName: hostile[3]!, serviceTypeName: hostile[2]!, commune: hostile[1]!, price: { amount: 1_000, ...VAT } }
    });

  /** Every (key, value) pair of the definition whose value is a string. */
  function stringProperties(value: unknown, key = "", out: Array<[string, string]> = []): Array<[string, string]> {
    if (typeof value === "string") {
      out.push([key, value]);
    } else if (Array.isArray(value)) {
      value.forEach((item) => stringProperties(item, key, out));
    } else if (typeof value === "object" && value !== null) {
      Object.entries(value).forEach(([childKey, child]) => stringProperties(child, childKey, out));
    }

    return out;
  }

  it("AG/AH/AI: snapshot strings only ever become text values; resource-bearing properties are code constants", () => {
    const model: IssuedQuoteDocumentModelV2 = buildIssuedQuoteDocumentModelV2(hostileSnapshot());
    const definition = buildDocumentDefinition(model, "data:image/png;base64,TEMPLATE-LOGO");
    const benign = buildDocumentDefinition(buildIssuedQuoteDocumentModelV2(createMixedTaxFixture()), "data:image/png;base64,TEMPLATE-LOGO");
    const resources = (pairs: Array<[string, string]>) => pairs.filter(([key]) => RESOURCE_KEYS.has(key));

    // Resource-bearing properties are exactly the template's, whatever the snapshot contains
    // (even text equal to the image key "issuerLogo" or the font name).
    expect(resources(stringProperties(definition))).toEqual(resources(stringProperties(benign)));
    expect(new Set(resources(stringProperties(definition)).map(([, value]) => value))).toEqual(new Set(["issuerLogo", "QuoteSans"]));

    for (const [key, value] of stringProperties(definition)) {
      if (!RESOURCE_KEYS.has(key) && hostile.some((input) => value.includes(input))) {
        expect(key, value).toBe("text");
      }
    }

    expect(Object.keys(definition.images as object)).toEqual(["issuerLogo"]);
    expect((definition.images as Record<string, string>).issuerLogo).toBe("data:image/png;base64,TEMPLATE-LOGO");
    expect((definition.defaultStyle as { font: string }).font).toBe("QuoteSans");
    expect(JSON.stringify(definition)).not.toMatch(/"(svg|link|linkToPage|attachment|attachments|files|qr)"/);
  });

  it("AG/AI: hostile text renders literally, with no link annotation, script or extra image", async () => {
    const pdf = await render(hostileSnapshot());
    const text = compact(await extractPdfText(pdf));
    const raw = pdf.toString("latin1");

    expect(text).toContain(compact("<script>alert('x')</script><b>negrita</b>"));
    expect(text).toContain(compact("https://evil.example/collect?q=1"));
    expect(raw).not.toMatch(/\/URI|\/Annots|\/Link|\/JavaScript|\/Launch|\/EmbeddedFile/);
    // The logo and its alpha mask only.
    expect(raw.match(/\/Subtype\s*\/Image/g)?.length).toBe(2);
  });

  it("AJ: the document pipeline imports no network client and no V1 document surface, and makes no network call", async () => {
    const closure = importClosure("src/application/quote-v2/document/issued-quote-document-model.ts", "src/infrastructure/documents/native-pdf-renderer.ts");

    for (const file of closure) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/from\s+"(node:)?(http|https|net|dns|tls|undici)"|\bfetch\(/);
    }

    expect(closure.filter((file) => /quote\/documents\/issued-quote-document|document-templates|issued-document-set|src\/domain\/|html-escaping|quote-email|document-formatting/.test(file))).toEqual([]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await render(createMixedTaxFixture());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("formal PDF: assets and readiness", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quote-pdf-assets-"));

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("probes the real stack in memory", async () => {
    expect(await renderer.probe()).toEqual({ ok: true });
  });

  it.each(["regular", "bold", "logo"] as const)("AK: a missing or altered pinned %s asset makes the renderer unavailable", async (asset) => {
    const altered = path.join(scratch, `${asset}-altered`);
    const source =
      asset === "logo" ? "src/infrastructure/branding/assets/files/logo-on-light.png" : path.join("src/infrastructure/documents/assets/fonts", RENDERER_PROFILE.fonts[asset].file);
    const bytes = fs.readFileSync(source);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(altered, bytes);

    for (const assetPath of [path.join(scratch, "does-not-exist"), altered]) {
      const broken = new NativePdfRenderer({ assetPaths: { [asset]: assetPath } });

      expect(await broken.probe()).toEqual({ ok: false, failureCategory: "renderer_unavailable" });
      const error: unknown = await broken.renderPdf(buildIssuedQuoteDocumentModelV2(createLinesFixture(1))).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DocumentRenderError);
      expect(error).toMatchObject({ reason: "renderer_unavailable", code: "document_generation_failed" });
      expect((error as Error).message).not.toContain(scratch);
    }
  });
});
