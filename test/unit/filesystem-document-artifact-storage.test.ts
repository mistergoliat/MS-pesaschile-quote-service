import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FilesystemDocumentArtifactStorage } from "../../src/infrastructure/documents/filesystem-document-artifact-storage";

describe("filesystem document artifact storage", () => {
  let rootPath: string;
  let storage: FilesystemDocumentArtifactStorage;

  beforeEach(async () => {
    rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-doc-storage-"));
    storage = new FilesystemDocumentArtifactStorage(rootPath);
  });

  afterEach(async () => {
    await fsPromises.rm(rootPath, {
      recursive: true,
      force: true
    });
  });

  it("writes, reads, lists, and deletes artifacts with real sha256 hashes", async () => {
    const html = "<html><body>hola</body></html>";
    const pdf = Buffer.from("%PDF-test");
    const htmlArtifact = await storage.writeText("quotes/q-1/hash-1/quote.html", html);
    const pdfArtifact = await storage.writeBuffer("quotes/q-1/hash-1/quote.pdf", pdf);

    expect(htmlArtifact.sha256).toBe(
      crypto.createHash("sha256").update(html, "utf8").digest("hex")
    );
    expect(pdfArtifact.sha256).toBe(crypto.createHash("sha256").update(pdf).digest("hex"));
    expect((await storage.readBuffer(htmlArtifact.storageKey)).toString("utf8")).toBe(html);
    expect(await storage.listStorageKeys("quotes")).toEqual([
      "quotes/q-1/hash-1/quote.html",
      "quotes/q-1/hash-1/quote.pdf"
    ]);

    await storage.deleteStorageKey(pdfArtifact.storageKey);
    expect(await storage.exists(pdfArtifact.storageKey)).toBe(false);

    await storage.deletePrefix("quotes/q-1");
    expect(await storage.listStorageKeys("quotes")).toEqual([]);
  });

  it("rejects path traversal and invalid storage keys", async () => {
    await expect(storage.writeText("../escape.txt", "nope")).rejects.toThrow(
      /Invalid storage key/
    );
    await expect(storage.writeText("quotes/../../escape.txt", "nope")).rejects.toThrow(
      /Invalid storage key/
    );
  });
});
