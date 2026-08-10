import type { IssuedDocumentSetInput, IssuedDocumentSetState } from "../../domain";

export interface QuoteDocumentStorageKeys {
  readonly directoryKey: string;
  readonly emailHtmlStorageKey: string;
  readonly htmlStorageKey: string;
  readonly pdfStorageKey: string;
}

export function buildQuoteDocumentStorageKeys(
  quoteId: string,
  contentHash: string,
  htmlSha256: string,
  pdfSha256: string
): QuoteDocumentStorageKeys {
  const directoryKey = `quotes/${quoteId}/${contentHash}`;

  return {
    directoryKey,
    emailHtmlStorageKey: `${directoryKey}/quote-email.html`,
    htmlStorageKey: `${directoryKey}/quote-${htmlSha256}.html`,
    pdfStorageKey: `${directoryKey}/quote-${pdfSha256}.pdf`
  };
}

export function buildDocumentDirectoryKey(
  quoteId: string,
  issuedDocument: Pick<IssuedDocumentSetInput | IssuedDocumentSetState, "contentHash">
): string {
  return `quotes/${quoteId}/${issuedDocument.contentHash}`;
}
