import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FilesystemDocumentArtifactStorage } from "../../src/infrastructure/documents/filesystem-document-artifact-storage";

describe("filesystem artifact storage readiness probe", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-storage-probe-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootPath, { recursive: true, force: true });
  });

  it("writes, reads back and deletes a dedicated probe file outside customer artifacts", async () => {
    const storage = new FilesystemDocumentArtifactStorage(rootPath);

    await expect(storage.probe()).resolves.toEqual({ ok: true });
    expect(await fsPromises.readdir(rootPath)).toEqual([".health"]);
    expect(await fsPromises.readdir(path.join(rootPath, ".health"))).toEqual([]);
    expect(await storage.listStorageKeys("quotes")).toEqual([]);
  });

  it("creates the configured root when it does not exist yet", async () => {
    const storage = new FilesystemDocumentArtifactStorage(path.join(rootPath, "nested", "root"));

    await expect(storage.probe()).resolves.toEqual({ ok: true });
  });

  it("fails when the root is not a usable directory", async () => {
    const blockedRoot = path.join(rootPath, "blocked");
    await fsPromises.writeFile(blockedRoot, "not a directory", "utf8");
    const storage = new FilesystemDocumentArtifactStorage(blockedRoot);

    const outcome = await storage.probe();
    expect(outcome.ok).toBe(false);
  });

  it("sweeps stale probe files left by a crashed process, keeping recent ones", async () => {
    const probeDirectory = path.join(rootPath, ".health");
    await fsPromises.mkdir(probeDirectory, { recursive: true });
    const stale = path.join(probeDirectory, "probe-1-stale.tmp");
    const recent = path.join(probeDirectory, "probe-2-recent.tmp");
    await fsPromises.writeFile(stale, "x");
    await fsPromises.writeFile(recent, "x");
    const oldTime = new Date(Date.now() - 10 * 60_000);
    await fsPromises.utimes(stale, oldTime, oldTime);

    await new FilesystemDocumentArtifactStorage(rootPath).probe();

    expect(await fsPromises.readdir(probeDirectory)).toEqual(["probe-2-recent.tmp"]);
  });
});
