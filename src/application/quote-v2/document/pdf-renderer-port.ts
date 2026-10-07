import type { RendererProbePort } from "../../health/dependency-state";
import type { IssuedQuoteDocumentModelV2 } from "./issued-quote-document-model";

/**
 * The formal-document renderer boundary (R1.5B2). It consumes only the V2
 * document model, never a commercial snapshot, and reports the code-owned
 * renderer version recorded on the manifest.
 */
export interface PdfRendererPort extends RendererProbePort {
  readonly rendererVersion: string;
  renderPdf(model: IssuedQuoteDocumentModelV2): Promise<Buffer>;
}

export type DocumentRenderFailure =
  /** A character of the document has no glyph in the pinned font set (never rendered as .notdef). */
  | "unsupported_glyph"
  /** Renderer assets, fonts or runtime profile are missing or do not match the pinned build. */
  | "renderer_unavailable"
  /** The PDF engine failed while laying out or writing the document. */
  | "render_failed";

/**
 * Typed renderer failure. Every reason maps to the issuance error code
 * `document_generation_failed` (B3). The message is fixed text: it never
 * contains snapshot text, file paths or stack details. `codePoints` (e.g.
 * "U+6F22") is diagnostic data for internal logs only.
 */
export class DocumentRenderError extends Error {
  override readonly name = "DocumentRenderError";
  readonly code = "document_generation_failed";

  constructor(
    readonly reason: DocumentRenderFailure,
    readonly codePoints: readonly string[] = []
  ) {
    super(`Document rendering failed: ${reason}`);
  }
}
