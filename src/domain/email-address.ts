import { DOMAIN_LIMITS } from "./constants";
import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import { ensureNonEmptyText } from "./shared";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidEmailAddress,
      "Email address contains invalid control characters",
      {
        field
      }
    );
  }
}

export function normalizeEmailAddress(value: string, field = "email"): string {
  const normalized = ensureNonEmptyText(value.trim().toLowerCase(), {
    field,
    code: DOMAIN_ERROR_CODES.invalidEmailAddress,
    maxLength: DOMAIN_LIMITS.delivery.maxRecipientLength,
    pattern: EMAIL_PATTERN
  });

  assertNoHeaderInjection(normalized, field);
  return normalized;
}

export function sanitizeHeaderText(value: string, field: string, maxLength: number): string {
  const normalized = ensureNonEmptyText(value.trim(), {
    field,
    code: DOMAIN_ERROR_CODES.invalidQuoteDelivery,
    maxLength
  });

  if (/[\r\n]/.test(normalized)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidQuoteDelivery,
      "Header text contains invalid control characters",
      {
        field
      }
    );
  }

  return normalized;
}
