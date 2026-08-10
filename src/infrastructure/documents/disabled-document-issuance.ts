import {
  APPLICATION_ERROR_CODES,
  ApplicationError
} from "../../application/quote/errors";
import type {
  CleanupIssuedArtifactsInput,
  DocumentIssuancePort,
  IssueQuoteDocumentsInput
} from "../../application/quote/ports/document-issuance-port";

export class DisabledDocumentIssuanceAdapter implements DocumentIssuancePort {
  issueForQuote(_input: IssueQuoteDocumentsInput): Promise<never> {
    void _input;

    return Promise.reject(
      new ApplicationError(
        APPLICATION_ERROR_CODES.documentIssuanceUnavailable,
        "Document issuance is unavailable until T05"
      )
    );
  }

  cleanupIssuedArtifacts(_input: CleanupIssuedArtifactsInput): Promise<void> {
    void _input;

    return Promise.resolve();
  }
}
