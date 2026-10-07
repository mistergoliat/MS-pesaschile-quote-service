import crypto from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

import {
  PRINCIPAL_ID_PATTERN,
  PRINCIPAL_TYPES,
  QUOTE_SCOPES,
  RESERVED_PRINCIPAL_IDS,
  type AuthenticatedPrincipal
} from "../../application/auth/principal";

/**
 * Configuration-backed principal registry (security contract §4, initial
 * mechanism): opaque random bearer tokens (≥ 256 bits), stored only as
 * SHA-256, at most two active tokens per principal for rotation, constant-time
 * comparison, reload without restart.
 *
 * Registry document:
 *   { "version": 1,
 *     "principals": [ { "principalId": "sales-integration", "principalType": "service",
 *                       "scopes": ["quotes:create", "quotes:read"],
 *                       "tokenSha256": ["<64 hex>"] } ] }
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** base64url of 32 random bytes is 43 characters; anything shorter cannot carry 256 bits. */
const TOKEN_PATTERN = /^[!-~]{43,512}$/;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

const registrySchema = z
  .object({
    version: z.literal(1),
    principals: z
      .array(
        z
          .object({
            principalId: z
              .string()
              .regex(PRINCIPAL_ID_PATTERN, "must be a lowercase system code")
              .refine((id) => !(RESERVED_PRINCIPAL_IDS as readonly string[]).includes(id), "is reserved"),
            principalType: z.enum(PRINCIPAL_TYPES),
            scopes: z
              .array(z.enum(QUOTE_SCOPES))
              .min(1, "at least one scope is required")
              .refine((scopes) => new Set(scopes).size === scopes.length, "scopes must not repeat"),
            tokenSha256: z
              .array(z.string().regex(SHA256_HEX, "must be a lowercase SHA-256 hex digest"))
              .min(1, "at least one token hash is required")
              .max(2, "at most two active tokens (rotation)")
          })
          .strict()
      )
      .min(1, "at least one principal is required")
  })
  .strict()
  .superRefine((registry, context) => {
    const seenIds = new Map<string, number>();
    const seenHashes = new Map<string, string>();

    for (const [index, principal] of registry.principals.entries()) {
      if (seenIds.has(principal.principalId)) {
        context.addIssue({
          code: "custom",
          path: ["principals", index, "principalId"],
          message: `duplicate principalId (also at principals.${seenIds.get(principal.principalId)})`
        });
      } else {
        seenIds.set(principal.principalId, index);
      }

      for (const [tokenIndex, hash] of principal.tokenSha256.entries()) {
        const owner = seenHashes.get(hash);

        // The hash value is never echoed: only which principals collide.
        if (owner !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["principals", index, "tokenSha256", tokenIndex],
            message: `duplicate credential (already assigned to ${owner})`
          });
        } else {
          seenHashes.set(hash, principal.principalId);
        }
      }
    }
  });

export interface PrincipalRegistryIssue {
  readonly path: string;
  readonly message: string;
}

/** Static configuration failure. Carries paths and rule messages only, never values. */
export class PrincipalRegistryError extends Error {
  override readonly name = "PrincipalRegistryError";

  constructor(
    message: string,
    readonly issues: readonly PrincipalRegistryIssue[] = []
  ) {
    super(message);
  }
}

export type PrincipalRegistrySource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly json: string };

interface RegistryEntry {
  readonly principal: AuthenticatedPrincipal;
  readonly tokenHashes: readonly Buffer[];
}

function parseRegistry(text: string): RegistryEntry[] {
  let document: unknown;

  try {
    document = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the input; never echo it.
    throw new PrincipalRegistryError("Principal registry is not valid JSON");
  }

  const result = registrySchema.safeParse(document);

  if (!result.success) {
    throw new PrincipalRegistryError(
      "Principal registry is invalid",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }

  return result.data.principals.map((principal) => ({
    principal: Object.freeze({
      principalId: principal.principalId,
      principalType: principal.principalType,
      scopes: new Set(principal.scopes)
    }),
    tokenHashes: principal.tokenSha256.map((hash) => Buffer.from(hash, "hex"))
  }));
}

function readSource(source: PrincipalRegistrySource): string {
  if (source.kind === "inline") {
    return source.json;
  }

  try {
    return fs.readFileSync(source.path, "utf8");
  } catch {
    throw new PrincipalRegistryError("Principal registry file is not readable");
  }
}

export class PrincipalRegistry {
  private entries: readonly RegistryEntry[];

  private constructor(
    private readonly source: PrincipalRegistrySource,
    entries: readonly RegistryEntry[]
  ) {
    this.entries = entries;
  }

  /** Loads and validates; throws PrincipalRegistryError on any problem. */
  static load(source: PrincipalRegistrySource): PrincipalRegistry {
    return new PrincipalRegistry(source, parseRegistry(readSource(source)));
  }

  get principalIds(): readonly string[] {
    return this.entries.map((entry) => entry.principal.principalId);
  }

  /** The registered principal with this id, or null (operator-plane attribution; no credential involved). */
  find(principalId: string): AuthenticatedPrincipal | null {
    return this.entries.find((entry) => entry.principal.principalId === principalId)?.principal ?? null;
  }

  /**
   * Re-reads the source (rotation/revocation without restart). An invalid
   * new registry is rejected and the current one stays active.
   */
  reload(): { readonly ok: true; readonly principals: number } | { readonly ok: false; readonly error: PrincipalRegistryError } {
    try {
      this.entries = parseRegistry(readSource(this.source));
      return { ok: true, principals: this.entries.length };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof PrincipalRegistryError ? error : new PrincipalRegistryError("Principal registry reload failed")
      };
    }
  }

  /**
   * Resolves an Authorization header to exactly one principal, or null.
   * The presented token is hashed and compared against every stored hash
   * with a constant-time comparison and no early exit.
   */
  authenticate(authorizationHeader: unknown): AuthenticatedPrincipal | null {
    if (typeof authorizationHeader !== "string") {
      return null;
    }

    const token = BEARER_PATTERN.exec(authorizationHeader.trim())?.[1];

    if (token === undefined || !TOKEN_PATTERN.test(token)) {
      return null;
    }

    const presented = crypto.createHash("sha256").update(token, "utf8").digest();
    let match: AuthenticatedPrincipal | null = null;

    for (const entry of this.entries) {
      for (const stored of entry.tokenHashes) {
        if (crypto.timingSafeEqual(presented, stored) && match === null) {
          match = entry.principal;
        }
      }
    }

    return match;
  }
}

/** Operator helper: a new ≥ 256-bit token and the hash to put in the registry. */
export function generatePrincipalToken(): { readonly token: string; readonly tokenSha256: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenSha256: crypto.createHash("sha256").update(token, "utf8").digest("hex")
  };
}
