import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface StoredDocumentArtifact {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function normalizeStorageKey(storageKey: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(storageKey) || storageKey.includes("..")) {
    throw new Error(`Invalid storage key: ${storageKey}`);
  }

  return storageKey.replace(/\\/g, "/");
}

export class FilesystemDocumentArtifactStorage {
  readonly #rootPath: string;

  constructor(rootPath: string) {
    this.#rootPath = path.resolve(rootPath);
  }

  get rootPath(): string {
    return this.#rootPath;
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
    const directoryPath = this.resolveStoragePath(prefixKey);

    if (!(await this.pathExists(directoryPath))) {
      return [];
    }

    return this.collectStorageKeys(directoryPath, prefixKey.replace(/\\/g, "/"));
  }

  private async collectStorageKeys(
    directoryPath: string,
    prefixKey: string
  ): Promise<string[]> {
    const entries = await fsPromises.readdir(directoryPath, {
      withFileTypes: true
    });
    const storageKeys: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const entryKey = prefixKey.length > 0 ? `${prefixKey}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        storageKeys.push(...(await this.collectStorageKeys(entryPath, entryKey)));
        continue;
      }

      if (entry.isFile()) {
        storageKeys.push(entryKey);
      }
    }

    return storageKeys;
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
