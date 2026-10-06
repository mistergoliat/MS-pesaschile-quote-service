import { ArtifactStoreError } from "./document/artifact-store-port";
import { InvalidIssuedSnapshotError } from "./document/issued-quote-document-model";
import { UnknownIssuerProfileError } from "./document/issuer-profiles";
import { DocumentRenderError } from "./document/pdf-renderer-port";
import type { AttemptFailure, IssuanceAttemptErrorCode } from "./issuance-operation";
import { SnapshotIntegrityError } from "./issued-snapshot";

/*
 * Amendment A5 retry classification of an issuance attempt failure, by error
 * type only (never by message text). The contractual `lastErrorCode` and the
 * internal retryability are separate decisions:
 *
 * | Failure                                   | lastErrorCode               | retryable |
 * |-------------------------------------------|-----------------------------|-----------|
 * | unsupported glyph (snapshot + renderer)   | document_generation_failed  | no        |
 * | snapshot not renderable (model builder)   | document_generation_failed  | no        |
 * | snapshot hash mismatch (integrity)        | document_generation_failed  | no        |
 * | different bytes at the content address    | document_storage_failed     | no        |
 * | renderer unavailable (assets/runtime)     | dependency_unavailable      | yes       |
 * | render engine failure (unknown cause)     | document_generation_failed  | yes       |
 * | storage unavailable / misconfigured       | document_storage_failed     | yes       |
 * | anything else                             | document_generation_failed  | yes       |
 *
 * Non-retryable means "the same snapshot with the same renderer/template
 * version cannot succeed" or "an integrity incident needs an operator": the
 * operation fails at once (T12) and an operator retry (T10) follows a fix.
 */

/** An attempt failure raised with an explicit classification. */
export class IssuanceAttemptError extends Error {
  override readonly name = "IssuanceAttemptError";

  constructor(
    readonly code: IssuanceAttemptErrorCode,
    readonly retryable = true,
    readonly reason: string = code
  ) {
    super(`Issuance attempt failed: ${code}`);
  }
}

export function classifyAttemptError(error: unknown): AttemptFailure {
  if (error instanceof IssuanceAttemptError) {
    return { errorCode: error.code, retryable: error.retryable, reason: error.reason };
  }

  if (error instanceof DocumentRenderError) {
    switch (error.reason) {
      case "unsupported_glyph":
        return { errorCode: "document_generation_failed", retryable: false, reason: "unsupported_glyph" };
      case "renderer_unavailable":
        return { errorCode: "dependency_unavailable", retryable: true, reason: "renderer_unavailable" };
      default:
        return { errorCode: "document_generation_failed", retryable: true, reason: "render_failed" };
    }
  }

  if (error instanceof InvalidIssuedSnapshotError || error instanceof UnknownIssuerProfileError) {
    return { errorCode: "document_generation_failed", retryable: false, reason: "snapshot_not_renderable" };
  }

  if (error instanceof SnapshotIntegrityError) {
    return { errorCode: "document_generation_failed", retryable: false, reason: "snapshot_integrity" };
  }

  if (error instanceof ArtifactStoreError) {
    return error.kind === "integrity_conflict"
      ? { errorCode: "document_storage_failed", retryable: false, reason: "artifact_integrity_conflict" }
      : { errorCode: "document_storage_failed", retryable: true, reason: error.kind };
  }

  return { errorCode: "document_generation_failed", retryable: true, reason: "unclassified" };
}
