import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { PROBE_OK, probeFailed, type ArtifactStorageProbePort, type FailureCategory, type ProbeOutcome } from "../../application/health/dependency-state";
import {
  ArtifactStoreError,
  contentAddressedPdfKey,
  type ArtifactStoreFailure,
  type ContentAddressedArtifactStore,
  type PublishedArtifact
} from "../../application/quote-v2/document/artifact-store-port";

/*
 * Filesystem implementation of the V2 content-addressed artifact store
 * (R1.5B3; protocol from the R1.5B0 audit §G, contract Domain §9.4).
 *
 * publish(bytes):
 *   1. sha = SHA-256(bytes); key = artifacts/sha256/<aa>/<bb>/<sha>.pdf
 *   2. temp = artifacts/tmp/<sha>.<uuid>.tmp, created exclusively ("wx"),
 *      written in full, fsync'd, closed (same filesystem as the final file)
 *   3. mkdir -p the final directory
 *   4. link(temp, final): atomic and never overwrites (EEXIST instead)
 *      - created: published
 *      - EEXIST: read and hash the existing file; identical → reuse;
 *        different → integrity_conflict (never replaced)
 *   5. unlink temp; fsync the final directory and its parent (POSIX)
 *   6. re-read the final file and verify SHA-256 and length
 *
 * Crash residue is limited to temp files (swept by age) and complete,
 * immutable, possibly unreferenced files at their content address (kept:
 * another attempt may adopt them). A file at a final address is never
 * partial: it only appears there through link() of a fully written temp.
 * Nothing under artifacts/sha256 is ever deleted by this class.
 *
 * Portability: Linux is the production target. Windows (NTFS) supports
 * hard links, so the same no-overwrite link() runs there; directory fsync
 * is not possible on Windows and is skipped (documented). A filesystem
 * without hard links fails the readiness probe instead of silently
 * degrading to an overwriting rename.
 */

const TEMP_DIRECTORY = "artifacts/tmp";
const TEMP_NAME = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/;
const PROBE_NAME = /^probe-[0-9a-f-]{36}(\.link)?\.tmp$/;
/** Temp files older than this are crash residue. A publication holds its temp for milliseconds. */
export const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/** The filesystem calls publication uses (injectable to simulate faults in tests). */
export interface PublishFs {
  open: typeof fsPromises.open;
  link: typeof fsPromises.link;
  mkdir: typeof fsPromises.mkdir;
  readFile: typeof fsPromises.readFile;
  unlink: typeof fsPromises.unlink;
}

export interface ContentAddressedStoreOptions {
  readonly tempMaxAgeMs?: number;
  readonly fs?: Partial<PublishFs>;
  readonly now?: () => number;
}

const errnoCode = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error && typeof (error).code === "string" ? (error as { code: string }).code : null;

const MISCONFIGURED = new Set(["EACCES", "EPERM", "EROFS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EISDIR", "ENOTDIR"]);

/** Typed classification by errno code only (never by message text). Unknown codes are transient. */
export function classifyFilesystemError(error: unknown): ArtifactStoreError {
  if (error instanceof ArtifactStoreError) {
    return error;
  }

  const code = errnoCode(error);
  const kind: ArtifactStoreFailure = code !== null && MISCONFIGURED.has(code) ? "storage_misconfigured" : "storage_unavailable";
  return new ArtifactStoreError(kind, code);
}

function probeCategory(error: unknown): FailureCategory {
  switch (errnoCode(error)) {
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

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

export class FilesystemContentAddressedArtifactStore implements ContentAddressedArtifactStore, ArtifactStorageProbePort {
  readonly #root: string;
  readonly #fs: PublishFs;
  readonly #tempMaxAgeMs: number;
  readonly #now: () => number;
  #lastSweepAt = 0;

  constructor(rootPath: string, options: ContentAddressedStoreOptions = {}) {
    this.#root = path.resolve(rootPath);
    this.#fs = {
      open: fsPromises.open,
      link: fsPromises.link,
      mkdir: fsPromises.mkdir,
      readFile: fsPromises.readFile,
      unlink: fsPromises.unlink,
      ...options.fs
    };
    this.#tempMaxAgeMs = options.tempMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
  }

  get rootPath(): string {
    return this.#root;
  }

  async publish(bytes: Buffer): Promise<PublishedArtifact> {
    const pdfSha256 = sha256(bytes);
    const storageKey = contentAddressedPdfKey(pdfSha256);
    const finalPath = this.resolve(storageKey);
    const tempPath = this.resolve(`${TEMP_DIRECTORY}/${pdfSha256}.${crypto.randomUUID()}.tmp`);
    let reused = false;

    try {
      await this.#fs.mkdir(path.dirname(tempPath), { recursive: true });
      await this.writeDurably(tempPath, bytes);
      await this.#fs.mkdir(path.dirname(finalPath), { recursive: true });

      try {
        await this.#fs.link(tempPath, finalPath);
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
          throw error;
        }

        // Never overwrite: an existing file must hold exactly these bytes.
        const existing = await this.#fs.readFile(finalPath);

        if (existing.byteLength !== bytes.byteLength || sha256(existing) !== pdfSha256) {
          throw new ArtifactStoreError("integrity_conflict");
        }

        reused = true;
      }
    } catch (error) {
      throw classifyFilesystemError(error);
    } finally {
      await this.#fs.unlink(tempPath).catch(() => undefined);
    }

    try {
      await this.syncDirectory(path.dirname(finalPath));
      await this.syncDirectory(path.dirname(path.dirname(finalPath)));
      // Contract step 4: verify the bytes actually at the final address.
      const stored = await this.#fs.readFile(finalPath);

      if (stored.byteLength !== bytes.byteLength || sha256(stored) !== pdfSha256) {
        throw new ArtifactStoreError("integrity_conflict");
      }
    } catch (error) {
      throw classifyFilesystemError(error);
    }

    return { storageKey, pdfSha256, byteLength: bytes.byteLength, reused };
  }

  /** Reads a published artifact and verifies it against its manifest values (B4 document read reuses this). */
  async readVerified(storageKey: string, expectedSha256: string, expectedByteLength: number): Promise<Buffer> {
    if (storageKey !== contentAddressedPdfKey(expectedSha256)) {
      throw new ArtifactStoreError("integrity_conflict");
    }

    let bytes: Buffer;

    try {
      bytes = await this.#fs.readFile(this.resolve(storageKey));
    } catch (error) {
      throw classifyFilesystemError(error);
    }

    if (bytes.byteLength !== expectedByteLength || sha256(bytes) !== expectedSha256) {
      throw new ArtifactStoreError("integrity_conflict");
    }

    return bytes;
  }

  /**
   * Readiness: the root is usable for publication. Exclusive temp create,
   * write, fsync, read back, hard link (the publication primitive) and
   * removal, all inside artifacts/tmp. No formal artifact is ever created.
   * Also sweeps stale temp files (at most once a minute).
   */
  async probe(): Promise<ProbeOutcome> {
    const directory = this.resolve(TEMP_DIRECTORY);
    const probePath = path.join(directory, `probe-${crypto.randomUUID()}.tmp`);
    const linkPath = probePath.replace(/\.tmp$/, ".link.tmp");
    const nonce = crypto.randomBytes(16);

    try {
      await this.#fs.mkdir(directory, { recursive: true });
      await this.writeDurably(probePath, nonce);
      await this.#fs.link(probePath, linkPath);
      const readBack = await this.#fs.readFile(linkPath);
      return readBack.equals(nonce) ? PROBE_OK : probeFailed("integrity");
    } catch (error) {
      return probeFailed(probeCategory(error));
    } finally {
      await this.#fs.unlink(linkPath).catch(() => undefined);
      await this.#fs.unlink(probePath).catch(() => undefined);

      if (this.#now() - this.#lastSweepAt >= SWEEP_INTERVAL_MS) {
        this.#lastSweepAt = this.#now();
        await this.sweepTemp().catch(() => undefined);
      }
    }
  }

  /**
   * Removes only service-owned temp files (publication temps and probe
   * files, by exact name pattern) in artifacts/tmp older than the max age.
   * Never touches artifacts/sha256 or any other file.
   */
  async sweepTemp(): Promise<{ readonly removed: number }> {
    const directory = this.resolve(TEMP_DIRECTORY);
    let entries: string[];

    try {
      entries = await fsPromises.readdir(directory);
    } catch {
      return { removed: 0 };
    }

    const cutoff = this.#now() - this.#tempMaxAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!TEMP_NAME.test(entry) && !PROBE_NAME.test(entry)) {
        continue;
      }

      const entryPath = path.join(directory, entry);
      const stat = await fsPromises.lstat(entryPath).catch(() => null);

      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await fsPromises.unlink(entryPath).then(
          () => {
            removed += 1;
          },
          () => undefined
        );
      }
    }

    return { removed };
  }

  private async writeDurably(file: string, bytes: Buffer): Promise<void> {
    const handle = await this.#fs.open(file, "wx");

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** fsync a directory so a new entry survives a crash (POSIX). Not possible on Windows: skipped there. */
  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") {
      return;
    }

    const handle = await this.#fs.open(directory, "r");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Root-confined path for a key built by this module (never caller input). */
  private resolve(key: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes("..")) {
      throw new ArtifactStoreError("storage_misconfigured");
    }

    const resolved = path.resolve(this.#root, key);

    if (!resolved.startsWith(`${this.#root}${path.sep}`)) {
      throw new ArtifactStoreError("storage_misconfigured");
    }

    return resolved;
  }
}
