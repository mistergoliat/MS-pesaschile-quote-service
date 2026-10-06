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

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The only V2 storage key: exactly the database check `quote_documents_content_addressed`. */
export function contentAddressedPdfKey(pdfSha256: string): string {
  if (!SHA256_HEX.test(pdfSha256)) {
    throw new TypeError("pdfSha256 must be 64 lowercase hex characters");
  }

  return `artifacts/sha256/${pdfSha256.slice(0, 2)}/${pdfSha256.slice(2, 4)}/${pdfSha256}.pdf`;
}
