import type { QuoteService } from "../../application/quote/quote-service";
import { buildQuoteDocumentStorageKeys } from "./document-paths";
import type { FilesystemDocumentArtifactStorage } from "./filesystem-document-artifact-storage";

export interface OrphanDocumentCleanupResult {
  readonly scannedCount: number;
  readonly deletedCount: number;
  readonly protectedCount: number;
}

export class OrphanDocumentCleanupService {
  constructor(
    private readonly storage: FilesystemDocumentArtifactStorage,
    private readonly quoteService: QuoteService
  ) {}

  async cleanupOrphans(input: {
    readonly now: string;
    readonly minAgeMs: number;
  }): Promise<OrphanDocumentCleanupResult> {
    const artifacts = await this.storage.listArtifacts("quotes");
    const issuedDocuments = await this.quoteService.listIssuedDocumentArtifacts();
    const liveStorageKeys = new Set<string>();
    let deletedCount = 0;
    let protectedCount = 0;

    for (const document of issuedDocuments) {
      const storageKeys = buildQuoteDocumentStorageKeys(
        document.quoteId,
        document.contentHash,
        document.htmlSha256,
        document.pdfSha256
      );

      liveStorageKeys.add(storageKeys.emailHtmlStorageKey);
      liveStorageKeys.add(document.htmlStorageKey);
      liveStorageKeys.add(document.pdfStorageKey);
    }

    for (const artifact of artifacts) {
      if (liveStorageKeys.has(artifact.storageKey)) {
        protectedCount += 1;
        continue;
      }

      if (Date.parse(input.now) - Date.parse(artifact.modifiedAt) < input.minAgeMs) {
        protectedCount += 1;
        continue;
      }

      await this.storage.deleteStorageKey(artifact.storageKey);
      deletedCount += 1;
    }

    return {
      scannedCount: artifacts.length,
      deletedCount,
      protectedCount
    };
  }
}
