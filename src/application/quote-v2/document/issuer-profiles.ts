/*
 * Versioned, code-owned issuer profiles (Domain §9.1, freeze record U3). The
 * formal document's issuer identity comes only from here: never from the
 * caller and never from live configuration. Changing any value that reaches
 * the document requires a new profile id (and therefore a new snapshot
 * `issuerProfileId` for new quotes) or a template version bump; an accepted
 * quote's profile id is frozen in its snapshot.
 *
 * U3 (issuer legal name, RUT, address, contact) is still open: the values
 * below are the current provisional ones and `contentStatus` says so. The
 * document renders an explicit pending notice instead of inventing a RUT or
 * an address.
 */

export interface IssuerProfile {
  readonly id: string;
  readonly legalName: string;
  /** Issuer RUT; null until U3 approves one (never fabricated). */
  readonly rut: string | null;
  /** Issuer address; null until U3 approves one. */
  readonly address: string | null;
  readonly website: string | null;
  /** Code-controlled brand asset id of the logo printed on the document. */
  readonly logoAssetId: string;
  readonly contentStatus: "provisional-u3" | "approved";
}

export const PESASCHILE_CL_V1: IssuerProfile = {
  id: "pesaschile-cl-v1",
  legalName: "Pesas Chile SPA",
  rut: null,
  address: null,
  website: "www.pesaschile.cl",
  logoAssetId: "asset://pesaschile-brand-v1/logo-on-light",
  contentStatus: "provisional-u3"
};

const PROFILES: ReadonlyMap<string, IssuerProfile> = new Map([[PESASCHILE_CL_V1.id, PESASCHILE_CL_V1]]);

export class UnknownIssuerProfileError extends Error {
  override readonly name = "UnknownIssuerProfileError";
}

export function issuerProfile(id: string): IssuerProfile {
  const profile = PROFILES.get(id);

  if (!profile) {
    throw new UnknownIssuerProfileError("issuer profile is not registered");
  }

  return profile;
}
