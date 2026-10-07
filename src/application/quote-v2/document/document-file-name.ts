/**
 * File name of the formal PDF: `<quoteNumber>.pdf` (openapi
 * `getQuoteDocument` `Content-Disposition`, and the email attachment).
 * Built from the quote number only, never from a storage key or path;
 * anything outside a conservative character set falls back to a fixed name.
 */
export function documentFileName(quoteNumber: string | null): string {
  return `${quoteNumber !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(quoteNumber) ? quoteNumber : "quote"}.pdf`;
}
