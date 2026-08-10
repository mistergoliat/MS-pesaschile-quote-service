import type { ReadStream } from "node:fs";

import type { QuoteSnapshot } from "../../domain";
import type { PublicIssuedDocumentDto } from "../../http/quote-presenter";
import type {
  PublicDocumentArtifactType,
  PublicDocumentReferencePayload,
  DocumentReferenceCodec
} from "./document-reference";
import { buildQuoteDocumentStorageKeys } from "./document-paths";
import type { FilesystemDocumentArtifactStorage } from "./filesystem-document-artifact-storage";

export interface ResolvedDocumentDownload {
  readonly artifactType: PublicDocumentArtifactType;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly sha256: string;
  readonly stream: ReadStream;
}

export class QuoteDocumentAccessService {
  constructor(
    private readonly storage: FilesystemDocumentArtifactStorage,
    private readonly referenceCodec: DocumentReferenceCodec
  ) {}

  toPublicIssuedDocument(
    quoteId: string,
    issuedDocument: QuoteSnapshot["issuedDocument"]
  ): PublicIssuedDocumentDto {
    if (!issuedDocument) {
      return {
        available: false,
        contentHash: null,
        renderVersion: null,
        generatedAt: null,
        pdf: {
          documentRef: null,
          sha256: null
        },
        html: {
          documentRef: null,
          sha256: null
        }
      };
    }

    return {
      available: true,
      contentHash: issuedDocument.contentHash,
      renderVersion: issuedDocument.renderVersion,
      generatedAt: issuedDocument.generatedAt,
      pdf: {
        documentRef: this.referenceCodec.encode({
          quoteId,
          artifactType: "pdf",
          contentHash: issuedDocument.contentHash
        }),
        sha256: issuedDocument.pdfSha256
      },
      html: {
        documentRef: this.referenceCodec.encode({
          quoteId,
          artifactType: "html",
          contentHash: issuedDocument.contentHash
        }),
        sha256: issuedDocument.htmlSha256
      }
    };
  }

  decodeDocumentReference(documentRef: string): PublicDocumentReferencePayload | null {
    return this.referenceCodec.decode(documentRef);
  }

  async resolveDownload(
    quote: QuoteSnapshot,
    documentRef: string
  ): Promise<ResolvedDocumentDownload | null> {
    const decoded = this.referenceCodec.decode(documentRef);

    if (!decoded || decoded.quoteId !== quote.quoteId || !quote.issuedDocument) {
      return null;
    }

    if (decoded.contentHash !== quote.issuedDocument.contentHash) {
      return null;
    }

    const storageKey =
      decoded.artifactType === "pdf"
        ? quote.issuedDocument.pdfStorageKey
        : quote.issuedDocument.htmlStorageKey;

    if (!(await this.storage.exists(storageKey))) {
      return null;
    }

    return {
      artifactType: decoded.artifactType,
      contentType:
        decoded.artifactType === "pdf" ? "application/pdf" : "text/html; charset=utf-8",
      contentDisposition:
        decoded.artifactType === "pdf"
          ? `attachment; filename="${quote.quoteNumber}.pdf"`
          : `inline; filename="${quote.quoteNumber}.html"`,
      sha256:
        decoded.artifactType === "pdf"
          ? quote.issuedDocument.pdfSha256
          : quote.issuedDocument.htmlSha256,
      stream: this.storage.createReadStream(storageKey)
    };
  }

  buildLiveStorageKeys(quote: QuoteSnapshot): ReadonlySet<string> {
    if (!quote.issuedDocument) {
      return new Set<string>();
    }

    const storageKeys = buildQuoteDocumentStorageKeys(
      quote.quoteId,
      quote.issuedDocument.contentHash,
      quote.issuedDocument.htmlSha256,
      quote.issuedDocument.pdfSha256
    );

    return new Set<string>([
      storageKeys.emailHtmlStorageKey,
      quote.issuedDocument.htmlStorageKey,
      quote.issuedDocument.pdfStorageKey
    ]);
  }

  async cleanupOrphanedArtifacts(liveStorageKeys: ReadonlySet<string>): Promise<number> {
    const storedKeys = await this.storage.listStorageKeys("quotes");
    let deletedCount = 0;

    for (const storageKey of storedKeys) {
      if (liveStorageKeys.has(storageKey)) {
        continue;
      }

      await this.storage.deleteStorageKey(storageKey);
      deletedCount += 1;
    }

    return deletedCount;
  }
}
