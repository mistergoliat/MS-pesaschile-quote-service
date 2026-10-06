import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStoreError, contentAddressedPdfKey } from "../../src/application/quote-v2/document/artifact-store-port";
import {
  classifyFilesystemError,
  FilesystemContentAddressedArtifactStore,
  type PublishFs
} from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { importClosure } from "../helpers/import-closure";

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
/** The database check `quote_documents_content_addressed`, verbatim. */
const dbKey = (sha: string) => `artifacts/sha256/${sha.substring(0, 2)}/${sha.substring(2, 4)}/${sha}.pdf`;
const pdfBytes = (label: string) => Buffer.from(`%PDF-1.3\n% fixture ${label}\n%%EOF\n`, "utf8");

let root: string;

beforeEach(async () => {
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-ca-store-"));
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

const at = (key: string) => path.join(root, ...key.split("/"));
const tempEntries = async () => fsPromises.readdir(at("artifacts/tmp")).catch(() => [] as string[]);

describe("content-addressed key", () => {
  it("B: is exactly artifacts/sha256/<aa>/<bb>/<sha>.pdf, matching the database check", () => {
    const sha = sha256(pdfBytes("key"));

    expect(contentAddressedPdfKey(sha)).toBe(dbKey(sha));
    expect(contentAddressedPdfKey(sha)).toMatch(/^artifacts\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/);
  });

  it("I: accepts only a lowercase 64-hex digest (no traversal, no identity data)", () => {
    for (const bad of ["../../etc/passwd", "A".repeat(64), "abc", `${"a".repeat(63)}/`, `${"a".repeat(62)}..`]) {
      expect(() => contentAddressedPdfKey(bad)).toThrow(TypeError);
    }
  });
});

describe("FilesystemContentAddressedArtifactStore.publish", () => {
  it("A/B/C: publishes new bytes at their content address and verifies them", async () => {
    const bytes = pdfBytes("new");
    const published = await new FilesystemContentAddressedArtifactStore(root).publish(bytes);

    expect(published).toEqual({ storageKey: dbKey(sha256(bytes)), pdfSha256: sha256(bytes), byteLength: bytes.byteLength, reused: false });
    expect(fs.readFileSync(at(published.storageKey)).equals(bytes)).toBe(true);
    expect(await tempEntries()).toEqual([]);
  });

  it("D: identical bytes published again reuse the existing file untouched", async () => {
    const store = new FilesystemContentAddressedArtifactStore(root);
    const bytes = pdfBytes("same");
    const first = await store.publish(bytes);
    const before = fs.statSync(at(first.storageKey));
    const second = await store.publish(bytes);

    expect(second).toEqual({ ...first, reused: true });
    expect(fs.statSync(at(first.storageKey)).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(at(first.storageKey)).equals(bytes)).toBe(true);
  });

  it("E: concurrent publications of the same bytes create the file exactly once", async () => {
    const store = new FilesystemContentAddressedArtifactStore(root);
    const bytes = pdfBytes("concurrent");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.publish(bytes)));

    expect(results.filter((result) => !result.reused)).toHaveLength(1);
    expect(new Set(results.map((result) => result.storageKey)).size).toBe(1);
    expect(fs.readFileSync(at(results[0]!.storageKey)).equals(bytes)).toBe(true);
    expect(await tempEntries()).toEqual([]);
  });

  it("F/G: different bytes already at the address are an integrity conflict and are never overwritten", async () => {
    const bytes = pdfBytes("intended");
    const key = dbKey(sha256(bytes));
    const corrupt = Buffer.from("%PDF-1.3 truncated");
    fs.mkdirSync(path.dirname(at(key)), { recursive: true });
    fs.writeFileSync(at(key), corrupt);

    const error = await new FilesystemContentAddressedArtifactStore(root).publish(bytes).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect(error).toMatchObject({ kind: "integrity_conflict" });
    expect(fs.readFileSync(at(key)).equals(corrupt)).toBe(true);
    expect(await tempEntries()).toEqual([]);
  });

  it("H/Z: an interrupted temp write leaves no file at the final address", async () => {
    const bytes = pdfBytes("interrupted");
    const failingOpen: PublishFs["open"] = async (file, flags, mode) => {
      const handle = await fsPromises.open(file, flags, mode);

      if (flags === "wx") {
        return Object.assign(Object.create(handle) as typeof handle, {
          writeFile: async (data: Buffer) => {
            await handle.writeFile(data.subarray(0, 5));
            throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
          },
          close: () => handle.close()
        });
      }

      return handle;
    };
    const store = new FilesystemContentAddressedArtifactStore(root, { fs: { open: failingOpen } });
    const error = await store.publish(bytes).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "storage_unavailable", fsCode: "ENOSPC" });
    expect(fs.existsSync(at(dbKey(sha256(bytes))))).toBe(false);
    expect(await tempEntries()).toEqual([]);
  });

  it("J: creates the temp exclusively, fsyncs it, links (never renames) it, and removes it", async () => {
    const calls: string[] = [];
    const tracing: Partial<PublishFs> = {
      open: (async (file: string, flags: string, mode?: number) => {
        const handle = await fsPromises.open(file, flags, mode);
        const relative = path.relative(root, file).split(path.sep).join("/");
        calls.push(`open:${flags}:${relative.startsWith("artifacts/tmp/") ? "tmp" : relative}`);
        return Object.assign(Object.create(handle) as typeof handle, {
          sync: async () => {
            calls.push("sync");
            await handle.sync();
          },
          writeFile: (data: Buffer) => handle.writeFile(data),
          close: () => handle.close()
        });
      }) as PublishFs["open"],
      link: async (from, to) => {
        calls.push("link");
        await fsPromises.link(from, to);
      },
      unlink: async (file) => {
        calls.push(`unlink:${path.basename(path.dirname(String(file)))}`);
        await fsPromises.unlink(file);
      }
    };
    const bytes = pdfBytes("traced");
    const key = dbKey(sha256(bytes));
    await new FilesystemContentAddressedArtifactStore(root, { fs: tracing }).publish(bytes);

    const directorySyncs =
      process.platform === "win32"
        ? []
        : [`open:r:${path.posix.dirname(key)}`, "sync", `open:r:${path.posix.dirname(path.posix.dirname(key))}`, "sync"];
    expect(calls).toEqual(["open:wx:tmp", "sync", "link", "unlink:tmp", ...directorySyncs]);
  });

  it("K: issuance code reaches no legacy mutable storage (writeBuffer/writeText/deletePrefix/deleteStorageKey)", () => {
    const closure = importClosure(
      "src/application/quote-v2/issuance-attempt.ts",
      "src/application/quote-v2/issuance-worker.ts",
      "src/application/quote-v2/inline-issuance.ts",
      "src/infrastructure/documents/content-addressed-artifact-store.ts",
      "src/infrastructure/persistence/postgres/issuance-operations.ts",
      "src/infrastructure/runtime/issuance-jobs.ts"
    );

    expect(closure.filter((file) => file.includes("filesystem-document-artifact-storage"))).toEqual([]);

    for (const file of closure) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/writeBuffer|writeText|deletePrefix|deleteStorageKey|\brm\(|rmdir|rename\(/);
    }
  });
});

describe("readVerified", () => {
  it("returns verified bytes and refuses a mismatching file or key", async () => {
    const store = new FilesystemContentAddressedArtifactStore(root);
    const bytes = pdfBytes("read");
    const published = await store.publish(bytes);

    expect((await store.readVerified(published.storageKey, published.pdfSha256, published.byteLength)).equals(bytes)).toBe(true);
    await expect(store.readVerified(published.storageKey, published.pdfSha256, published.byteLength + 1)).rejects.toMatchObject({ kind: "integrity_conflict" });
    await expect(store.readVerified(dbKey("a".repeat(64)), published.pdfSha256, published.byteLength)).rejects.toMatchObject({ kind: "integrity_conflict" });
  });
});

describe("error classification", () => {
  it("classifies by errno code only, never by message", () => {
    const withCode = (code: string, message = "document_storage_failed integrity_conflict") => Object.assign(new Error(message), { code });

    expect(classifyFilesystemError(withCode("ENOSPC"))).toMatchObject({ kind: "storage_unavailable", fsCode: "ENOSPC" });
    expect(classifyFilesystemError(withCode("EIO"))).toMatchObject({ kind: "storage_unavailable" });
    expect(classifyFilesystemError(withCode("EACCES"))).toMatchObject({ kind: "storage_misconfigured" });
    expect(classifyFilesystemError(withCode("EROFS"))).toMatchObject({ kind: "storage_misconfigured" });
    expect(classifyFilesystemError(new Error("integrity_conflict EACCES"))).toMatchObject({ kind: "storage_unavailable", fsCode: null });
    expect(new ArtifactStoreError("integrity_conflict", "EEXIST").message).not.toMatch(/[\\/]/);
  });
});

describe("temp sweep and readiness probe", () => {
  it("removes only old service temp files; recent temps, final artifacts and foreign files are untouched", async () => {
    const store = new FilesystemContentAddressedArtifactStore(root, { tempMaxAgeMs: 60_000 });
    const published = await store.publish(pdfBytes("kept"));
    const tmp = at("artifacts/tmp");
    const old = Date.now() / 1000 - 3_600;
    const sha = "b".repeat(64);
    const files = {
      oldTemp: path.join(tmp, `${sha}.${crypto.randomUUID()}.tmp`),
      oldProbe: path.join(tmp, `probe-${crypto.randomUUID()}.tmp`),
      recentTemp: path.join(tmp, `${sha}.${crypto.randomUUID()}.tmp`),
      foreignInTmp: path.join(tmp, "operator-notes.txt"),
      foreignOutside: at("artifacts/readme.txt")
    };

    for (const file of Object.values(files)) {
      fs.writeFileSync(file, "x");
    }

    for (const file of [files.oldTemp, files.oldProbe, files.foreignInTmp, files.foreignOutside, at(published.storageKey)]) {
      fs.utimesSync(file, old, old);
    }

    expect(await store.sweepTemp()).toEqual({ removed: 2 });
    expect(fs.existsSync(files.oldTemp)).toBe(false);
    expect(fs.existsSync(files.oldProbe)).toBe(false);
    expect(fs.existsSync(files.recentTemp)).toBe(true);
    expect(fs.existsSync(files.foreignInTmp)).toBe(true);
    expect(fs.existsSync(files.foreignOutside)).toBe(true);
    expect(fs.existsSync(at(published.storageKey))).toBe(true);
  });

  it("an active publication's temp is far younger than the sweep age (default 1 h)", async () => {
    let sweptDuringPublish: number | null = null;
    const store: FilesystemContentAddressedArtifactStore = new FilesystemContentAddressedArtifactStore(root, {
      fs: {
        link: async (from, to) => {
          sweptDuringPublish = (await store.sweepTemp()).removed;
          await fsPromises.link(from, to);
        }
      }
    });

    await store.publish(pdfBytes("active"));
    expect(sweptDuringPublish).toBe(0);
  });

  it("R: the probe proves temp write/fsync/link/read/remove and creates no formal artifact", async () => {
    const store = new FilesystemContentAddressedArtifactStore(root);

    expect(await store.probe()).toEqual({ ok: true });
    expect(fs.existsSync(at("artifacts/sha256"))).toBe(false);
    expect(await tempEntries()).toEqual([]);
  });

  it("the probe reports an unusable root", async () => {
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "a file, not a directory");

    expect((await new FilesystemContentAddressedArtifactStore(blocked).probe()).ok).toBe(false);
  });
});
