export const DOMAIN_ERROR_CODES = {
  invalidQuoteStatusTransition: "invalid_quote_status_transition",
  draftOnlyOperation: "draft_only_operation",
  quoteAlreadyTerminal: "quote_already_terminal",
  quoteMissingRequiredFieldsForIssue: "quote_missing_required_fields_for_issue",
  quoteHasNoItems: "quote_has_no_items",
  invalidValidUntil: "invalid_valid_until",
  invalidCurrency: "invalid_currency",
  invalidLineQuantity: "invalid_line_quantity",
  invalidLinePrice: "invalid_line_price",
  invalidTaxRate: "invalid_tax_rate",
  invalidCustomerSnapshot: "invalid_customer_snapshot",
  invalidActor: "invalid_actor",
  invalidSource: "invalid_source",
  invalidDocumentSet: "invalid_document_set",
  invalidQuoteNumber: "invalid_quote_number",
  invalidQuoteReference: "invalid_quote_reference",
  invalidMoneyAmount: "invalid_money_amount",
  optimisticConcurrencyConflict: "optimistic_concurrency_conflict",
  quoteAlreadySuperseded: "quote_already_superseded"
} as const;

export type DomainErrorCode =
  (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES];

export class DomainError extends Error {
  override readonly name = "DomainError";
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
