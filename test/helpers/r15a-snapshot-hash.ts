import { sha256Jcs } from "../../src/application/quote/canonical-json";

type Json = Record<string, unknown>;

/**
 * Frozen copy of the R1.5A semantic snapshot derivation (removed from
 * quote-v2-acceptance.ts in R1.5B1): SHA-256(JCS) over the issued-snapshot
 * members of a public `Quote` representation. Tests use it as an independent
 * oracle that the dedicated issued-snapshot module still produces the hashes
 * stored for quotes accepted before the refactor. Never change it.
 */
export function r15aSemanticSnapshotHash(quote: Json): string {
  return sha256Jcs({
    quoteId: quote.quoteId,
    quoteNumber: quote.quoteNumber,
    currency: quote.currency,
    issuerProfileId: (quote.issuance as Json).issuerProfileId,
    issuedAt: (quote.issuance as Json).issuedAt,
    validity: quote.validity,
    customer: quote.customer,
    lines: quote.lines,
    shipping: quote.shipping,
    totals: quote.totals
  });
}
