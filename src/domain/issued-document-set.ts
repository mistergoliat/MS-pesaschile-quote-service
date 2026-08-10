import { DOMAIN_LIMITS } from "./constants";
import { DOMAIN_ERROR_CODES } from "./errors";
import {
  ensureNonEmptyText,
  parseTimestamp,
  type TimestampInput
} from "./shared";

export interface IssuedDocumentSetInput {
  readonly contentHash: string;
  readonly renderVersion: string;
  readonly pdfStorageKey: string;
  readonly pdfSha256: string;
  readonly htmlStorageKey: string;
  readonly htmlSha256: string;
  readonly generatedAt: TimestampInput;
}

export interface IssuedDocumentSetState {
  readonly contentHash: string;
  readonly renderVersion: string;
  readonly pdfStorageKey: string;
  readonly pdfSha256: string;
  readonly htmlStorageKey: string;
  readonly htmlSha256: string;
  readonly generatedAt: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CONTENT_HASH_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class IssuedDocumentSet {
  readonly #state: IssuedDocumentSetState;

  private constructor(state: IssuedDocumentSetState) {
    this.#state = state;
  }

  static create(input: IssuedDocumentSetInput): IssuedDocumentSet {
    return new IssuedDocumentSet({
      contentHash: ensureNonEmptyText(input.contentHash, {
        field: "issuedDocument.contentHash",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: DOMAIN_LIMITS.document.maxContentHashLength,
        pattern: CONTENT_HASH_PATTERN
      }),
      renderVersion: ensureNonEmptyText(input.renderVersion, {
        field: "issuedDocument.renderVersion",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: DOMAIN_LIMITS.document.maxRenderVersionLength
      }),
      pdfStorageKey: ensureNonEmptyText(input.pdfStorageKey, {
        field: "issuedDocument.pdfStorageKey",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: DOMAIN_LIMITS.document.maxStorageKeyLength
      }),
      pdfSha256: ensureNonEmptyText(input.pdfSha256, {
        field: "issuedDocument.pdfSha256",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: 64,
        pattern: SHA256_PATTERN
      }),
      htmlStorageKey: ensureNonEmptyText(input.htmlStorageKey, {
        field: "issuedDocument.htmlStorageKey",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: DOMAIN_LIMITS.document.maxStorageKeyLength
      }),
      htmlSha256: ensureNonEmptyText(input.htmlSha256, {
        field: "issuedDocument.htmlSha256",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet,
        maxLength: 64,
        pattern: SHA256_PATTERN
      }),
      generatedAt: parseTimestamp(input.generatedAt, {
        field: "issuedDocument.generatedAt",
        code: DOMAIN_ERROR_CODES.invalidDocumentSet
      })
    });
  }

  toSnapshot(): IssuedDocumentSetState {
    return {
      ...this.#state
    };
  }
}
