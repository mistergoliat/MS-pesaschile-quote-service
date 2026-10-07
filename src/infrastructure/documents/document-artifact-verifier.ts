import type {
  ArtifactIntegrityStatus,
  CommittedArtifactReader
} from "../../application/quote-v2/document/artifact-store-port";
import type { SqlQueryable } from "../persistence/postgres/postgres";

/*
 * Integrity verifier (R1.5B4): committed manifests → stored bytes, through
 * the same verified read the document endpoint uses
 * (FilesystemContentAddressedArtifactStore.readVerified). DETECTION ONLY:
 * it never writes, moves, repairs, re-renders or deletes an artifact and
 * never changes a V2 manifest (Domain §9.3; repair is a future operator
 * procedure that must reproduce the recorded pdfSha256).
 *
 * The one historical exception is opt-in and legacy-only: with
 * `recordLegacyByteLength`, the verified size of a migrated V1 artifact whose
 * size was never recorded is written once (the only manifest change the
 * immutability trigger permits; V1 migration §D). V2 manifests are never
 * touched.
 *
 * Manifests are read in keyset batches, so the check is bounded in memory
 * whatever the table size. The report carries ids and statuses only: no
 * storage key, path or customer data.
 */

export type ArtifactProblemStatus = Exclude<ArtifactIntegrityStatus, "OK">;

export interface ArtifactVerification {
  readonly documentId: string;
  readonly quoteId: string;
  readonly origin: "issuance" | "legacy_v1";
  readonly status: ArtifactProblemStatus;
}

export interface ArtifactVerificationReport {
  readonly checked: number;
  readonly ok: number;
  readonly byStatus: Readonly<Record<ArtifactIntegrityStatus, number>>;
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

const DEFAULT_BATCH_SIZE = 200;

export async function verifyDocumentArtifacts(input: {
  readonly database: SqlQueryable;
  readonly store: CommittedArtifactReader;
  readonly recordLegacyByteLength: boolean;
  readonly batchSize?: number;
}): Promise<ArtifactVerificationReport> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const byStatus: Record<ArtifactIntegrityStatus, number> = {
    OK: 0,
    MISSING: 0,
    HASH_MISMATCH: 0,
    LENGTH_MISMATCH: 0,
    READ_FAILED: 0,
    KEY_INVALID: 0,
    OVERSIZED: 0
  };
  const problems: ArtifactVerification[] = [];
  let checked = 0;
  let byteLengthsRecorded = 0;
  let after: string | null = null;

  for (;;) {
    const { rows }: { rows: ManifestRow[] } = await input.database.query<ManifestRow>(
      `select document_id, quote_id, origin, pdf_sha256, storage_key, byte_length::text
       from quote_service.quote_documents
       where $1::uuid is null or document_id > $1::uuid
       order by document_id
       limit $2`,
      [after, batchSize]
    );

    for (const row of rows) {
      checked += 1;
      const result = await input.store.readVerified({
        origin: row.origin,
        storageKey: row.storage_key,
        pdfSha256: row.pdf_sha256,
        byteLength: row.byte_length === null ? null : Number(row.byte_length)
      });
      byStatus[result.status] += 1;

      if (result.status !== "OK") {
        problems.push({ documentId: row.document_id, quoteId: row.quote_id, origin: row.origin, status: result.status });
        continue;
      }

      if (input.recordLegacyByteLength && row.origin === "legacy_v1" && row.byte_length === null) {
        await input.database.query(
          `update quote_service.quote_documents set byte_length = $2
           where document_id = $1 and origin = 'legacy_v1' and byte_length is null`,
          [row.document_id, result.bytes.byteLength]
        );
        byteLengthsRecorded += 1;
      }
    }

    if (rows.length < batchSize) {
      break;
    }

    after = rows[rows.length - 1]!.document_id;
  }

  problems.sort((a, b) => a.quoteId.localeCompare(b.quoteId));
  return { checked, ok: byStatus.OK, byStatus, problems, byteLengthsRecorded };
}
