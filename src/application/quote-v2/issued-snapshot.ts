import { sha256Jcs } from "../quote/canonical-json";

/*
 * The issued snapshot (Domain §9.2): exactly the frozen fields that identify
 * what an issuance must render, and the input of the semantic snapshot hash
 * (`jcs-sha256-v2`) stored on every issuance operation and manifest.
 *
 * This representation is owned here, not by the public read projection: a
 * change to a `GET` response must never change the hash of a quote that was
 * already accepted. Its members reproduce, byte for byte under JCS, the R1.5A
 * derivation the stored hashes were computed with (golden tests in
 * test/unit/issued-snapshot.test.ts): an absent optional member is omitted,
 * never `null`, except where a `null` member was always part of the shape
 * (`shipping`, `validity.policyId`, `validity.override`, ...).
 */

export const ISSUED_SNAPSHOT_HASH_ALGORITHM = "jcs-sha256-v2";

export interface IssuedCharge {
  readonly amount: number;
  readonly taxBasis: string;
  readonly taxRate?: string;
}

export interface IssuedAmounts {
  readonly net: number;
  readonly tax: number;
  readonly gross: number;
}

export interface IssuedProvenance {
  readonly sourceSystem: string;
  readonly reference?: string;
  readonly asOf?: string;
}

export interface IssuedLine {
  readonly lineId: string;
  readonly position: number;
  readonly kind: string;
  readonly item: {
    readonly sourceSystem: string;
    readonly productRef?: string;
    readonly variantRef?: string;
    readonly sku?: string;
    readonly description: string;
    readonly attributes?: readonly unknown[];
  };
  readonly quantity: { readonly value: string; readonly unit: string };
  readonly unitPrice: IssuedCharge;
  readonly pricingProvenance?: IssuedProvenance;
  readonly amounts: IssuedAmounts;
}

export interface IssuedShipping {
  readonly carrier: { readonly code?: string; readonly name: string };
  readonly serviceType?: { readonly code?: string; readonly name?: string };
  readonly destination: { readonly commune: string; readonly region?: string; readonly country: string };
  readonly amount: IssuedCharge;
  readonly sourceQuote?: IssuedProvenance;
  readonly amounts: IssuedAmounts;
}

export interface IssuedValidity {
  readonly source: string;
  readonly policyId: string | null;
  readonly issuerZone: string;
  readonly tzdbVersion: string | null;
  readonly issueLocalDate: string;
  readonly validThroughLocalDate: string;
  readonly validUntilExclusive: string;
  readonly override: { readonly principalId: string; readonly reasonCode: string } | null;
}

export interface IssuedSnapshot {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly currency: string;
  readonly issuerProfileId: string;
  readonly issuedAt: string;
  readonly validity: IssuedValidity;
  /** The quote-specific customer snapshot exactly as stored. */
  readonly customer: Readonly<Record<string, unknown>>;
  readonly lines: readonly IssuedLine[];
  readonly shipping: IssuedShipping | null;
  readonly totals: IssuedAmounts & { readonly exemptNet: number };
}

/** Semantic snapshot hash (`jcs-sha256-v2`): SHA-256 of the JCS form of the issued snapshot fields, and nothing else. */
export function issuedSnapshotHash(snapshot: IssuedSnapshot): string {
  return sha256Jcs({
    quoteId: snapshot.quoteId,
    quoteNumber: snapshot.quoteNumber,
    currency: snapshot.currency,
    issuerProfileId: snapshot.issuerProfileId,
    issuedAt: snapshot.issuedAt,
    validity: snapshot.validity,
    customer: snapshot.customer,
    lines: snapshot.lines,
    shipping: snapshot.shipping,
    totals: snapshot.totals
  });
}

/** The stored snapshot no longer hashes to what was accepted: never render, never repair. */
export class SnapshotIntegrityError extends Error {
  override readonly name = "SnapshotIntegrityError";

  constructor(
    readonly operationId: string,
    readonly expectedHash: string,
    readonly actualHash: string
  ) {
    super("Issued snapshot hash does not match the accepted snapshot hash");
  }
}
