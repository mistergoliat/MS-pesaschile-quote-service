import { sanitizeHeaderText } from "../../domain";

export function buildQuoteEmailSubject(quoteNumber: string): string {
  return sanitizeHeaderText(
    `Cotizacion Pesas Chile ${quoteNumber}`,
    "emailSubject",
    200
  );
}
