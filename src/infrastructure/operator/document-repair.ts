import crypto from "node:crypto";

import {
  ArtifactStoreError,
  contentAddressedPdfKey,
  type CommittedArtifactManifest,
  type CommittedArtifactReader,
  type ContentAddressedArtifactStore
} from "../../application/quote-v2/document/artifact-store-port";
import { buildIssuedQuoteDocumentModelV2, type IssuedQuoteDocumentModelV2 } from "../../application/quote-v2/document/issued-quote-document-model";
import type { PdfRendererPort } from "../../application/quote-v2/document/pdf-renderer-port";
import { TEMPLATE_VERSION } from "../../application/quote-v2/document/template-v5";
import { ISSUED_SNAPSHOT_HASH_ALGORITHM, issuedSnapshotHash, type IssuedSnapshot } from "../../application/quote-v2/issued-snapshot";
import type { PrincipalRegistry } from "../auth/principal-registry";
import { loadIssuedSnapshot } from "../persistence/postgres/issued-snapshot-loader";
import type { PostgresDatabase } from "../persistence/postgres/postgres";
import { OPERATOR_EXIT, operatorRejected, resolveOperatorPrincipal, type OperatorResult } from "./operator-plane";

/*
 * documents:repair (R1.6C; Domain §9.3, pre-flight §25): restores the BYTES
 * of a committed V2 formal PDF whose artifact is missing, by re-rendering it
 * from the frozen issued snapshot and publishing it only if it reproduces the
 * recorded pdfSha256 exactly. Operator-initiated only: never automatic,
 * never a job, never HTTP.
 *
 * The committed manifest is the authority and is never written: repair has
 * no database write at all (no manifest, quote, operation or audit change;
 * the frozen audit vocabulary has no repair event, so the operator record is
 * this command's output). Refused, with nothing published, when:
 *
 * - the manifest is a migrated V1 one (the V1 renderer is retired);
 * - the manifest is inconsistent (operation not succeeded, snapshot hash
 *   differs from the operation's, unknown hash algorithm, storage key not the
 *   content address of pdfSha256);
 * - the running rendererVersion / templateVersion is not EXACTLY the recorded
 *   one, or the renderer is unavailable;
 * - the frozen snapshot no longer hashes to the recorded semantic hash, or its
 *   issuer profile cannot be resolved;
 * - the candidate bytes do not hash to the recorded pdfSha256 (HASH_MISMATCH:
 *   the fundamental invariant);
 * - different bytes already sit at the content address: the write-once store
 *   never replaces them (integrity_conflict); the operator quarantines that
 *   file first (runbook), the command never deletes or overwrites.
 */

export interface DocumentRepairInput {
  readonly quoteId: string;
  /** Optional cross-check: must be the quote's own manifest. */
  readonly documentId?: string | undefined;
  readonly operatorPrincipalId: string;
  /** False: dry run (reads and renders in memory, publishes nothing). True: publish. */
  readonly confirm: boolean;
}

export interface DocumentRepairDependencies {
  readonly database: Pick<PostgresDatabase, "withTransaction">;
  readonly store: ContentAddressedArtifactStore & CommittedArtifactReader;
  readonly renderer: PdfRendererPort;
  readonly operators: Pick<PrincipalRegistry, "find">;
}

interface ManifestRow {
  document_id: string;
  quote_id: string;
  operation_id: string;
  origin: "issuance" | "legacy_v1";
  semantic_snapshot_hash: string;
  semantic_hash_algorithm: string;
  pdf_sha256: string;
  byte_length: string | null;
  renderer_version: string;
  template_version: string;
  storage_key: string;
  operation_status: string;
  operation_snapshot_hash: string;
}

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

export async function repairDocumentArtifact(dependencies: DocumentRepairDependencies, input: DocumentRepairInput): Promise<OperatorResult> {
  const operator = resolveOperatorPrincipal(dependencies.operators, input.operatorPrincipalId);

  if (!operator.ok) {
    return operatorRejected(operator.reason);
  }

  // Manifest and frozen snapshot from one consistent, read-only snapshot.
  const loaded = await dependencies.database.withTransaction(async (client) => {
    await client.query("set transaction isolation level repeatable read, read only");
    const quote = await client.query<{ status: string }>(`select status from quote_service.quotes where quote_id = $1`, [input.quoteId]);

    if (quote.rows.length === 0) {
      return { kind: "QUOTE_NOT_FOUND" } as const;
    }

    const { rows } = await client.query<ManifestRow>(
      `select d.document_id, d.quote_id, d.operation_id, d.origin, d.semantic_snapshot_hash, d.semantic_hash_algorithm, d.pdf_sha256,
              d.byte_length::text as byte_length, d.renderer_version, d.template_version, d.storage_key,
              o.status as operation_status, o.snapshot_hash as operation_snapshot_hash
       from quote_service.quote_documents d
       join quote_service.issuance_operations o on o.operation_id = d.operation_id and o.quote_id = d.quote_id
       where d.quote_id = $1`,
      [input.quoteId]
    );
    const manifest = rows[0];

    if (!manifest) {
      return { kind: "NO_DOCUMENT", quoteStatus: quote.rows[0]!.status } as const;
    }

    const snapshot = manifest.origin === "issuance" ? await loadIssuedSnapshot(client, input.quoteId) : null;
    return { kind: "LOADED", manifest, snapshot } as const;
  });

  if (loaded.kind === "QUOTE_NOT_FOUND") {
    return { exitCode: OPERATOR_EXIT.NOT_APPLICABLE, body: { status: "not_applicable", reason: "QUOTE_NOT_FOUND", quoteId: input.quoteId } };
  }

  if (loaded.kind === "NO_DOCUMENT") {
    // A quote without a committed manifest has no formal document to restore.
    if (input.documentId !== undefined) {
      return refused(input, operator.principalId, null, "MANIFEST_QUOTE_MISMATCH");
    }

    return {
      exitCode: OPERATOR_EXIT.NOT_APPLICABLE,
      body: { status: "not_applicable", reason: "NO_DOCUMENT", quoteId: input.quoteId, quoteStatus: loaded.quoteStatus }
    };
  }

  const { manifest, snapshot } = loaded;

  if (input.documentId !== undefined && input.documentId !== manifest.document_id) {
    return refused(input, operator.principalId, null, "MANIFEST_QUOTE_MISMATCH");
  }

  const report = {
    event: "document.repair",
    operatorPrincipalId: operator.principalId,
    quoteId: manifest.quote_id,
    documentId: manifest.document_id,
    origin: manifest.origin,
    pdfSha256: manifest.pdf_sha256,
    rendererVersion: manifest.renderer_version,
    templateVersion: manifest.template_version
  };

  const refuse = (reason: string, extra: Record<string, unknown> = {}): OperatorResult => refused(input, operator.principalId, report, reason, extra);

  if (manifest.origin === "legacy_v1") {
    return refuse("NOT_REPAIRABLE_LEGACY");
  }

  if (
    manifest.operation_status !== "succeeded" ||
    manifest.semantic_hash_algorithm !== ISSUED_SNAPSHOT_HASH_ALGORITHM ||
    manifest.semantic_snapshot_hash !== manifest.operation_snapshot_hash ||
    manifest.byte_length === null
  ) {
    return refuse("MANIFEST_INCONSISTENT");
  }

  if (manifest.storage_key !== contentAddressedPdfKey(manifest.pdf_sha256)) {
    return refuse("STORAGE_KEY_INVALID");
  }

  const committed: CommittedArtifactManifest = {
    origin: "issuance",
    storageKey: manifest.storage_key,
    pdfSha256: manifest.pdf_sha256,
    byteLength: Number(manifest.byte_length)
  };
  const integrity = await dependencies.store.readVerified(committed);

  if (integrity.status === "OK") {
    // Nothing to restore: no render, no publication, no rewrite.
    return { exitCode: OPERATOR_EXIT.OK, body: { status: "already_intact", dryRun: !input.confirm, integrity: "OK", ...report } };
  }

  if (integrity.status === "KEY_INVALID" || integrity.status === "OVERSIZED") {
    return refuse("STORAGE_KEY_INVALID", { integrity: integrity.status });
  }

  // Exact historical versions only: no prefix, major or "compatible" match.
  if (manifest.renderer_version !== dependencies.renderer.rendererVersion) {
    return refuse("RENDERER_VERSION_MISMATCH", { integrity: integrity.status, runningRendererVersion: dependencies.renderer.rendererVersion });
  }

  if (manifest.template_version !== TEMPLATE_VERSION) {
    return refuse("TEMPLATE_VERSION_MISMATCH", { integrity: integrity.status, runningTemplateVersion: TEMPLATE_VERSION });
  }

  if (!(await dependencies.renderer.probe()).ok) {
    return refuse("RENDERER_UNAVAILABLE", { integrity: integrity.status });
  }

  if (issuedSnapshotHash(snapshot!) !== manifest.semantic_snapshot_hash) {
    return refuse("SNAPSHOT_HASH_MISMATCH", { integrity: integrity.status });
  }

  const model = buildModel(snapshot!);

  if (model === null || model.templateVersion !== manifest.template_version) {
    return refuse("DOCUMENT_MODEL_UNAVAILABLE", { integrity: integrity.status });
  }

  let candidate: Buffer;

  try {
    candidate = await dependencies.renderer.renderPdf(model);
  } catch {
    return refuse("RENDER_FAILED", { integrity: integrity.status });
  }

  // The fundamental invariant: only the exact recorded bytes may be published.
  if (sha256(candidate) !== manifest.pdf_sha256 || candidate.byteLength !== committed.byteLength) {
    return refuse("HASH_MISMATCH", { integrity: integrity.status });
  }

  // A file is present at the address (corrupt or unreadable): write-once
  // publication cannot replace it.
  const addressOccupied = integrity.status !== "MISSING";

  if (!input.confirm) {
    return {
      exitCode: addressOccupied ? OPERATOR_EXIT.REFUSED : OPERATOR_EXIT.OK,
      body: { status: "dry_run", dryRun: true, outcome: addressOccupied ? "would_conflict" : "would_repair", integrity: integrity.status, reproducible: true, ...report }
    };
  }

  let published;

  try {
    published = await dependencies.store.publish(candidate);
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.kind === "integrity_conflict") {
      return refuse("INTEGRITY_CONFLICT", { integrity: integrity.status, reproducible: true });
    }

    return {
      exitCode: OPERATOR_EXIT.FAILED,
      body: { status: "storage_unavailable", storageFailure: error instanceof ArtifactStoreError ? error.kind : "unknown", ...report }
    };
  }

  const verified = published.storageKey === committed.storageKey ? await dependencies.store.readVerified(committed) : null;

  if (verified?.status !== "OK" || !verified.bytes.equals(candidate)) {
    return refuse("INTEGRITY_CONFLICT", { integrity: verified?.status ?? "KEY_INVALID" });
  }

  return {
    exitCode: OPERATOR_EXIT.OK,
    body: { status: published.reused ? "already_restored" : "repaired", dryRun: false, previousIntegrity: integrity.status, integrity: "OK", ...report }
  };
}

function buildModel(snapshot: IssuedSnapshot): IssuedQuoteDocumentModelV2 | null {
  try {
    return buildIssuedQuoteDocumentModelV2(snapshot);
  } catch {
    // Unknown issuer profile or a malformed frozen value: never "best effort".
    return null;
  }
}

function refused(
  input: DocumentRepairInput,
  operatorPrincipalId: string,
  report: Record<string, unknown> | null,
  reason: string,
  extra: Record<string, unknown> = {}
): OperatorResult {
  return {
    exitCode: OPERATOR_EXIT.REFUSED,
    body: {
      status: "refused",
      reason,
      dryRun: !input.confirm,
      ...(report ?? { event: "document.repair", operatorPrincipalId, quoteId: input.quoteId }),
      ...extra
    }
  };
}
