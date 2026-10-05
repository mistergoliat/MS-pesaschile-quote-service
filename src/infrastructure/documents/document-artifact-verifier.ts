import crypto from "node:crypto";

import type { SqlQueryable } from "../persistence/postgres/postgres";
import type { FilesystemDocumentArtifactStorage } from "./filesystem-document-artifact-storage";

export type ArtifactVerificationStatus = "ok" | "missing" | "hash_mismatch" | "byte_length_mismatch" | "unreadable";

export interface ArtifactVerification {
  readonly documentId: string;
  readonly quoteId: string;
  readonly origin: "issuance" | "legacy_v1";
  readonly status: ArtifactVerificationStatus;
}

export interface ArtifactVerificationReport {
  readonly checked: number;
  readonly ok: number;
  readonly problems: readonly ArtifactVerification[];
  readonly byteLengthsRecorded: number;
}

interface ManifestRow {
  readonly document_id: string;
  readonly quote_id: string;
  readonly origin: "issuance" | "legacy_v1";
  readonly pdf_sha256: string;
  readonly storage_key: string;
  readonly byte_length: string | null;
}

/**
 * Verifies every committed manifest against the stored bytes. Never writes,
 * moves or regenerates an artifact: a missing or altered file is reported as
 * a data exception for the operator (Domain contract §9.3). With
 * `recordLegacyByteLength`, the verified size of a legacy V1 artifact is
 * recorded once (the only manifest change the immutability trigger permits).
 * The report carries ids and statuses only.
 */
export async function verifyDocumentArtifacts(input: {
  readonly database: SqlQueryable;
  readonly storage: FilesystemDocumentArtifactStorage;
  readonly recordLegacyByteLength: boolean;
}): Promise<ArtifactVerificationReport> {
  const manifests = await input.database.query<ManifestRow>(
    `select document_id, quote_id, origin, pdf_sha256, storage_key, byte_length::text
     from quote_service.quote_documents
     order by quote_id`
  );
  const problems: ArtifactVerification[] = [];
  let ok = 0;
  let byteLengthsRecorded = 0;

  for (const row of manifests.rows) {
    const result = await verifyOne(input.storage, row);

    if (result.status !== "ok") {
      problems.push({ documentId: row.document_id, quoteId: row.quote_id, origin: row.origin, status: result.status });
      continue;
    }

    ok += 1;

    if (input.recordLegacyByteLength && row.origin === "legacy_v1" && row.byte_length === null) {
      await input.database.query(
        `update quote_service.quote_documents set byte_length = $2 where document_id = $1 and byte_length is null`,
        [row.document_id, result.byteLength]
      );
      byteLengthsRecorded += 1;
    }
  }

  return {
    checked: manifests.rows.length,
    ok,
    problems,
    byteLengthsRecorded
  };
}

async function verifyOne(
  storage: FilesystemDocumentArtifactStorage,
  row: ManifestRow
): Promise<
  | { readonly status: "ok"; readonly byteLength: number }
  | { readonly status: Exclude<ArtifactVerificationStatus, "ok"> }
> {
  let bytes: Buffer;

  try {
    bytes = await storage.readBuffer(row.storage_key);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return { status: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }

  if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.pdf_sha256) {
    return { status: "hash_mismatch" };
  }

  if (row.byte_length !== null && Number(row.byte_length) !== bytes.byteLength) {
    return { status: "byte_length_mismatch" };
  }

  return { status: "ok", byteLength: bytes.byteLength };
}
