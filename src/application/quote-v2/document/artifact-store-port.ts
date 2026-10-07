/*
 * V2 formal-document storage boundary (R1.5B3). Content addressed and write
 * once: a PDF lives at `artifacts/sha256/<aa>/<bb>/<sha256>.pdf` and is never
 * overwritten or deleted by issuance. Publication completes only after the
 * bytes at the final address are re-read and verified, so a manifest can only
 * ever name bytes that exist (I5/I6).
 */

export interface PublishedArtifact {
  readonly storageKey: string;
  readonly pdfSha256: string;
  readonly byteLength: number;
  /** True when identical bytes were already at the address (another attempt published them). */
  readonly reused: boolean;
}

export type ArtifactStoreFailure =
  /** Transient filesystem condition (space, I/O, root temporarily unreachable). Retryable. */
  | "storage_unavailable"
  /** Permission, read-only or unsupported-link configuration. Needs an operator fix; retryable within the deadline. */
  | "storage_misconfigured"
  /** Different bytes already sit at the content address (or the verified re-read differs). Never overwritten: an incident. */
  | "integrity_conflict";

/** Typed storage failure. The message is fixed text: never a path or a driver message. `fsCode` is the errno code, if any. */
export class ArtifactStoreError extends Error {
  override readonly name = "ArtifactStoreError";

  constructor(
    readonly kind: ArtifactStoreFailure,
    readonly fsCode: string | null = null
  ) {
    super(`Artifact storage failed: ${kind}`);
  }
}

export interface ContentAddressedArtifactStore {
  publish(bytes: Buffer): Promise<PublishedArtifact>;
}

/*
 * Verified read of a COMMITTED artifact (R1.5B4). The input always comes from
 * a committed `quote_documents` row, never from a caller. Integrity only:
 * a missing or altered file is reported, never repaired, re-rendered,
 * overwritten or deleted (Domain §9.3).
 */

/** Operational safety bound for one stored PDF. A 100-line V2 quote is about 63 KB (formal-document-v2.md §8). */
export const MAX_COMMITTED_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** A committed manifest's storage facts (internal columns; never returned by the API). */
export interface CommittedArtifactManifest {
  readonly origin: "issuance" | "legacy_v1";
  readonly storageKey: string;
  readonly pdfSha256: string;
  /** Null only for a migrated V1 artifact whose size was never recorded (V1 migration §D). */
  readonly byteLength: number | null;
}

export type ArtifactIntegrityStatus =
  | "OK"
  /** No file at the storage key (disk loss, deleted, unmounted root). */
  | "MISSING"
  /** The file's SHA-256 differs from the manifest. */
  | "HASH_MISMATCH"
  /** The file's size differs from the manifest's byteLength. */
  | "LENGTH_MISMATCH"
  /** The file exists but cannot be read as a regular file (I/O, permission, symlink, directory). */
  | "READ_FAILED"
  /** The manifest's key is unsafe, or a V2 key does not match its content address. */
  | "KEY_INVALID"
  /** Larger than MAX_COMMITTED_DOCUMENT_BYTES: refused before allocating. */
  | "OVERSIZED";

export type VerifiedArtifactRead =
  | { readonly status: "OK"; readonly bytes: Buffer }
  | { readonly status: Exclude<ArtifactIntegrityStatus, "OK">; readonly fsCode: string | null };

export interface CommittedArtifactReader {
  /** Reads and verifies the bytes once; only the returned buffer may be served (no verify-then-reopen window). */
  readVerified(manifest: CommittedArtifactManifest): Promise<VerifiedArtifactRead>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The only V2 storage key: exactly the database check `quote_documents_content_addressed`. */
export function contentAddressedPdfKey(pdfSha256: string): string {
  if (!SHA256_HEX.test(pdfSha256)) {
    throw new TypeError("pdfSha256 must be 64 lowercase hex characters");
  }

  return `artifacts/sha256/${pdfSha256.slice(0, 2)}/${pdfSha256.slice(2, 4)}/${pdfSha256}.pdf`;
}
