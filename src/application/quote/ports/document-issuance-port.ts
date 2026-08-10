import type { IssuedDocumentSetInput, QuoteSnapshot } from "../../../domain";

export interface IssueQuoteDocumentsInput {
  readonly quote: QuoteSnapshot;
  readonly issuedAt: string;
  readonly operationId: string;
}

export interface CleanupIssuedArtifactsInput {
  readonly quoteId: string;
  readonly issuedDocument: IssuedDocumentSetInput;
  readonly preserveIssuedDocument?: IssuedDocumentSetInput;
}

export interface DocumentIssuancePort {
  issueForQuote(input: IssueQuoteDocumentsInput): Promise<IssuedDocumentSetInput>;
  cleanupIssuedArtifacts(input: CleanupIssuedArtifactsInput): Promise<void>;
}

