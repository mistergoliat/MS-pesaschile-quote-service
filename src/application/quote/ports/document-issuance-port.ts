import type { IssuedDocumentSetInput, QuoteSnapshot } from "../../../domain";

export interface IssueQuoteDocumentsInput {
  readonly quote: QuoteSnapshot;
  readonly issuedAt: string;
}

export interface DocumentIssuancePort {
  issueForQuote(input: IssueQuoteDocumentsInput): Promise<IssuedDocumentSetInput>;
}

