import crypto from "node:crypto";

import type { IssuedDocumentSetInput } from "../../domain";
import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "../../application/quote/errors";
import {
  buildCanonicalIssuedQuoteSnapshot,
  buildIssuedQuoteDocumentViewModel,
  createIssuedQuoteContentHash
} from "../../application/quote/documents/issued-quote-document";
import type {
  CleanupIssuedArtifactsInput,
  DocumentIssuancePort,
  IssueQuoteDocumentsInput
} from "../../application/quote/ports/document-issuance-port";
import type { FilesystemDocumentArtifactStorage } from "./filesystem-document-artifact-storage";
import { buildDocumentDirectoryKey, buildQuoteDocumentStorageKeys } from "./document-paths";
import { renderQuoteEmailHtml, renderQuotePrintableHtml } from "./document-templates";
import type { PdfRendererPort } from "./puppeteer-pdf-renderer";

export interface QuoteDocumentIssuanceConfig {
  readonly companyName: string;
  readonly renderVersion: string;
}

export class RealDocumentIssuanceAdapter implements DocumentIssuancePort {
  constructor(
    private readonly storage: FilesystemDocumentArtifactStorage,
    private readonly pdfRenderer: PdfRendererPort,
    private readonly config: QuoteDocumentIssuanceConfig
  ) {}

  async issueForQuote(input: IssueQuoteDocumentsInput): Promise<IssuedDocumentSetInput> {
    const snapshot = buildCanonicalIssuedQuoteSnapshot(input.quote, input.issuedAt);
    const contentHash = createIssuedQuoteContentHash(snapshot);
    const viewModel = buildIssuedQuoteDocumentViewModel({
      snapshot,
      renderVersion: this.config.renderVersion,
      companyName: this.config.companyName
    });
    const directoryKey = buildDocumentDirectoryKey(input.quote.quoteId, { contentHash });

    try {
      const emailHtml = renderQuoteEmailHtml(viewModel);
      const printableHtml = renderQuotePrintableHtml(viewModel);
      const pdf = await this.pdfRenderer.renderPdf(printableHtml);
      const htmlSha256 = crypto.createHash("sha256").update(printableHtml, "utf8").digest("hex");
      const pdfSha256 = crypto.createHash("sha256").update(pdf).digest("hex");
      const storageKeys = buildQuoteDocumentStorageKeys(
        input.quote.quoteId,
        contentHash,
        htmlSha256,
        pdfSha256
      );
      const [, storedPrintableHtml, storedPdf] = await Promise.all([
        this.storage.writeText(storageKeys.emailHtmlStorageKey, emailHtml),
        this.storage.writeText(storageKeys.htmlStorageKey, printableHtml),
        this.storage.writeBuffer(storageKeys.pdfStorageKey, pdf)
      ]);

      return {
        contentHash,
        renderVersion: this.config.renderVersion,
        pdfStorageKey: storedPdf.storageKey,
        pdfSha256: storedPdf.sha256,
        htmlStorageKey: storedPrintableHtml.storageKey,
        htmlSha256: storedPrintableHtml.sha256,
        generatedAt: input.issuedAt
      };
    } catch (error) {
      await this.storage.deletePrefix(directoryKey).catch(() => undefined);

      if (error instanceof ApplicationError) {
        throw error;
      }

      if (error instanceof Error) {
        const reason = error.message.toLowerCase();

        if (
          error.name.toLowerCase().includes("timeout") ||
          reason.includes("protocol error") ||
          reason.includes("browser") ||
          reason.includes("target closed")
        ) {
          throw new ApplicationError(
            APPLICATION_ERROR_CODES.documentGenerationFailed,
            "Document generation failed",
            {
              quoteId: input.quote.quoteId,
              reason: error.message
            }
          );
        }
      }

      throw new ApplicationError(
        APPLICATION_ERROR_CODES.documentStorageFailed,
        "Document storage failed",
        {
          quoteId: input.quote.quoteId
        }
      );
    }
  }

  async cleanupIssuedArtifacts(input: CleanupIssuedArtifactsInput): Promise<void> {
    if (
      input.preserveIssuedDocument &&
      input.preserveIssuedDocument.contentHash === input.issuedDocument.contentHash
    ) {
      if (input.preserveIssuedDocument.htmlStorageKey !== input.issuedDocument.htmlStorageKey) {
        await this.storage.deleteStorageKey(input.issuedDocument.htmlStorageKey);
      }

      if (input.preserveIssuedDocument.pdfStorageKey !== input.issuedDocument.pdfStorageKey) {
        await this.storage.deleteStorageKey(input.issuedDocument.pdfStorageKey);
      }

      return;
    }

    await this.storage.deletePrefix(buildDocumentDirectoryKey(input.quoteId, input.issuedDocument));
  }
}
