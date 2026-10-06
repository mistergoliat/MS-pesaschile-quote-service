import type { ContentAddressedArtifactStore } from "./document/artifact-store-port";
import { buildIssuedQuoteDocumentModelV2 } from "./document/issued-quote-document-model";
import type { PdfRendererPort } from "./document/pdf-renderer-port";
import type { IssuanceFailpoints } from "./issuance-failpoints";
import type { IssuanceOperationRepository } from "./issuance-operation";
import type { AttemptBody, WorkerLogger } from "./issuance-worker";

/*
 * The real issuance attempt body (R1.5B3), run by IssuanceWorker under a
 * claimed, renewed lease after the frozen snapshot was reloaded and its
 * semantic hash verified:
 *
 *   document model (pure) → render (B2) → content-addressed publish (verified)
 *   → fenced T5 commit
 *
 * ARTIFACT WRITE BEFORE MANIFEST: the commit only runs after the bytes are
 * verified at their final address, so a manifest never names missing bytes.
 * The lease signal is checked between steps; once the lease is lost (or the
 * process stops) no further business effect is attempted. A published file
 * is never deleted, whatever happens next: it is immutable and another
 * attempt may adopt it. Failures are thrown and classified by the worker
 * (attempt-failure.ts); nothing here retries.
 */

export interface IssuanceAttemptDependencies {
  readonly repository: Pick<IssuanceOperationRepository, "commitIssued">;
  readonly renderer: PdfRendererPort;
  readonly store: ContentAddressedArtifactStore;
  readonly logger: WorkerLogger;
  /** Test compositions only (issuance-failpoints.ts); production passes nothing. */
  readonly failpoints?: IssuanceFailpoints | undefined;
}

export function createIssuanceAttemptBody(dependencies: IssuanceAttemptDependencies): AttemptBody {
  const { repository, renderer, store, logger, failpoints } = dependencies;

  return async ({ attempt, snapshot, signal, correlationId }) => {
    const checkpoint = { operationId: attempt.operationId, generation: attempt.generation };
    const model = buildIssuedQuoteDocumentModelV2(snapshot);

    if (signal.aborted) {
      return { kind: "abandoned" };
    }

    logger.info({ event: "issuance.render_started", operationId: attempt.operationId, generation: attempt.generation }, "Rendering formal quote document");
    const pdf = await renderer.renderPdf(model);
    await failpoints?.reach("after_render", checkpoint);

    if (signal.aborted) {
      return { kind: "abandoned" };
    }

    const published = await store.publish(pdf);
    logger.info(
      {
        event: "issuance.artifact_published",
        operationId: attempt.operationId,
        generation: attempt.generation,
        pdfSha256: published.pdfSha256,
        byteLength: published.byteLength,
        reused: published.reused
      },
      "Formal quote document published"
    );
    await failpoints?.reach("after_artifact_published", checkpoint);

    if (signal.aborted) {
      // The file stays: immutable, content addressed, possibly adopted by the next holder.
      return { kind: "abandoned" };
    }

    await failpoints?.reach("before_t5", checkpoint);
    const committed = await repository.commitIssued(attempt, {
      semanticSnapshotHash: attempt.snapshotHash,
      pdfSha256: published.pdfSha256,
      byteLength: published.byteLength,
      storageKey: published.storageKey,
      rendererVersion: renderer.rendererVersion,
      templateVersion: model.templateVersion,
      correlationId
    });

    if (committed.kind === "COMMITTED") {
      await failpoints?.reach("after_t5_commit", checkpoint);
      return { kind: "succeeded" };
    }

    logger.warn(
      { event: "issuance.stale_fence", operationId: attempt.operationId, generation: attempt.generation, result: committed.kind },
      "Issuance commit not applied; attempt abandoned"
    );
    return { kind: "abandoned" };
  };
}
