import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  PROBE_OK,
  probeFailed,
  type ArtifactStorageProbePort,
  type FailureCategory,
  type ProbeOutcome
} from "../../application/health/dependency-state";

// Health probes live outside the "quotes/" prefix so they are never customer
// artifacts and never seen by orphan cleanup.
const HEALTH_PROBE_DIRECTORY = ".health";
const STALE_PROBE_AGE_MS = 60_000;

function classifyStorageFailure(error: unknown): FailureCategory {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error).code
      : undefined;

  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return "storage_full";
    case "EROFS":
      return "storage_read_only";
    case "EACCES":
    case "EPERM":
      return "permission";
    default:
      return "unreachable";
  }
}

export interface StoredDocumentArtifact {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface StoredDocumentArtifactMetadata {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

function normalizeStorageKey(storageKey: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(storageKey) || storageKey.includes("..")) {
    throw new Error(`Invalid storage key: ${storageKey}`);
  }

  return storageKey.replace(/\\/g, "/");
}

export class FilesystemDocumentArtifactStorage implements ArtifactStorageProbePort {
  readonly #rootPath: string;

  constructor(rootPath: string) {
    this.#rootPath = path.resolve(rootPath);
  }

  get rootPath(): string {
    return this.#rootPath;
  }

  /**
   * Proves the root supports the operations issuance needs: create a file,
   * read it back intact, delete it. Uses a dedicated probe file that is always
   * removed; probe files left by a crashed process are swept after a minute.
   */
  async probe(): Promise<ProbeOutcome> {
    const probeDirectory = path.join(this.#rootPath, HEALTH_PROBE_DIRECTORY);
    const probePath = path.join(probeDirectory, `probe-${process.pid}-${crypto.randomUUID()}.tmp`);
    const nonce = crypto.randomBytes(16).toString("hex");

    try {
      await fsPromises.mkdir(probeDirectory, {
        recursive: true
      });
      await fsPromises.writeFile(probePath, nonce, "utf8");
      const readBack = await fsPromises.readFile(probePath, "utf8");

      if (readBack !== nonce) {
        return probeFailed("integrity");
      }

      return PROBE_OK;
    } catch (error) {
      return probeFailed(classifyStorageFailure(error));
    } finally {
      await fsPromises.rm(probePath, { force: true }).catch(() => undefined);
      await this.sweepStaleProbes(probeDirectory);
    }
  }

  private async sweepStaleProbes(probeDirectory: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(probeDirectory);
      const cutoff = Date.now() - STALE_PROBE_AGE_MS;

      for (const entry of entries) {
        if (!entry.startsWith("probe-")) {
          continue;
        }

        const entryPath = path.join(probeDirectory, entry);
        const stat = await fsPromises.stat(entryPath).catch(() => null);

        if (stat && stat.mtimeMs < cutoff) {
          await fsPromises.rm(entryPath, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // Nothing to sweep, or the root is unavailable; the probe already reported it.
    }
  }

  async writeText(storageKey: string, content: string): Promise<StoredDocumentArtifact> {
    return this.writeBuffer(storageKey, Buffer.from(content, "utf8"));
  }

  async writeBuffer(storageKey: string, content: Buffer): Promise<StoredDocumentArtifact> {
    const targetPath = this.resolveStoragePath(storageKey);

    await fsPromises.mkdir(path.dirname(targetPath), {
      recursive: true
    });
    await fsPromises.writeFile(targetPath, content);

    return {
      storageKey: normalizeStorageKey(storageKey),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength
    };
  }

  async readBuffer(storageKey: string): Promise<Buffer> {
    return fsPromises.readFile(this.resolveStoragePath(storageKey));
  }

  createReadStream(storageKey: string): fs.ReadStream {
    return fs.createReadStream(this.resolveStoragePath(storageKey));
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await fsPromises.access(this.resolveStoragePath(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async deleteStorageKey(storageKey: string): Promise<void> {
    await fsPromises.rm(this.resolveStoragePath(storageKey), {
      force: true
    });
  }

  async deletePrefix(prefixKey: string): Promise<void> {
    await fsPromises.rm(this.resolveStoragePath(prefixKey), {
      recursive: true,
      force: true
    });
  }

  async listStorageKeys(prefixKey = ""): Promise<string[]> {
    return (await this.listArtifacts(prefixKey)).map((artifact) => artifact.storageKey);
  }

  async listArtifacts(prefixKey = ""): Promise<StoredDocumentArtifactMetadata[]> {
    const directoryPath = this.resolveStoragePath(prefixKey);

    if (!(await this.pathExists(directoryPath))) {
      return [];
    }

    return this.collectArtifacts(directoryPath, prefixKey.replace(/\\/g, "/"));
  }

  private async collectArtifacts(
    directoryPath: string,
    prefixKey: string
  ): Promise<StoredDocumentArtifactMetadata[]> {
    const entries = await fsPromises.readdir(directoryPath, {
      withFileTypes: true
    });
    const artifacts: StoredDocumentArtifactMetadata[] = [];

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const entryKey = prefixKey.length > 0 ? `${prefixKey}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        artifacts.push(...(await this.collectArtifacts(entryPath, entryKey)));
        continue;
      }

      if (entry.isFile()) {
        const stat = await fsPromises.stat(entryPath);
        artifacts.push({
          storageKey: entryKey,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString()
        });
      }
    }

    return artifacts;
  }

  private resolveStoragePath(storageKey: string): string {
    const normalized = normalizeStorageKey(storageKey);
    const resolvedPath = path.resolve(this.#rootPath, normalized);

    if (
      resolvedPath !== this.#rootPath &&
      !resolvedPath.startsWith(`${this.#rootPath}${path.sep}`)
    ) {
      throw new Error(`Storage path escaped root: ${storageKey}`);
    }

    return resolvedPath;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fsPromises.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
