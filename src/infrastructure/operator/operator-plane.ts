import { PRINCIPAL_ID_PATTERN, RESERVED_PRINCIPAL_IDS } from "../../application/auth/principal";
import { OPERATOR_REASON_CODE_PATTERN } from "../../application/quote-v2/issuance-operation";
import type { PrincipalRegistry } from "../auth/principal-registry";
import type { AppEnv } from "../config/env";
import { buildConnectionConfig, PostgresDatabase } from "../persistence/postgres/postgres";
import { PostgresDependencyProbe } from "../persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../persistence/postgres/schema-head";

/*
 * Operator plane (R1.6C): the shared rules of the host-side operator commands
 * (issuance:failed, issuance:retry, documents:repair). There is no HTTP
 * surface and no bearer token: authority is host access plus database
 * credentials, an explicit registered operator principal (W6) and the frozen
 * state checks. No environment variable relaxes any of it.
 *
 * Output is one JSON object of ids, codes and versions: never customer data,
 * commercial content, recipients, PDF bytes, storage paths or stack traces.
 * Rejected input values are never echoed.
 */

export const OPERATOR_EXIT = {
  /** The command did what was asked (including an empty listing and a passing dry run). */
  OK: 0,
  /** It could not run: database, storage or an unexpected runtime failure. */
  FAILED: 1,
  /** Refused: integrity, schema, configuration, invocation or operator-principal failure. */
  REFUSED: 2,
  /** Not applicable: the state does not allow the action (already retried, state changed, legacy document). */
  NOT_APPLICABLE: 3
} as const;

export type OperatorExitCode = (typeof OPERATOR_EXIT)[keyof typeof OPERATOR_EXIT];

export interface OperatorResult {
  readonly exitCode: OperatorExitCode;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Invalid invocation. The message names the flag and the rule, never the value. */
export class OperatorUsageError extends Error {
  override readonly name = "OperatorUsageError";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT_PATTERN = /^[1-9][0-9]{0,3}$/;
export const MAX_LIST_LIMIT = 1_000;

/** uuid, principal id, reason/error code, positive limit, or a value-less switch. */
export type OperatorFlagKind = "uuid" | "principal" | "code" | "limit" | "switch";

type FlagValue<K extends OperatorFlagKind> = K extends "switch" ? boolean : K extends "limit" ? number : string;

export type ParsedOperatorArguments<S extends Record<string, OperatorFlagKind>> = { readonly [P in keyof S]?: FlagValue<S[P]> };

function parseValue(flag: string, kind: Exclude<OperatorFlagKind, "switch">, raw: string): string | number {
  switch (kind) {
    case "uuid":
      if (!UUID_PATTERN.test(raw.toLowerCase())) {
        throw new OperatorUsageError(`--${flag} must be a UUID`);
      }

      return raw.toLowerCase();
    case "principal":
      if (!PRINCIPAL_ID_PATTERN.test(raw)) {
        throw new OperatorUsageError(`--${flag} must be a principal id (^[a-z0-9][a-z0-9._-]{0,63}$)`);
      }

      return raw;
    case "code":
      if (!OPERATOR_REASON_CODE_PATTERN.test(raw)) {
        throw new OperatorUsageError(`--${flag} must be a machine-readable code (^[a-z][a-z0-9_]{1,63}$)`);
      }

      return raw;
    case "limit":
      if (!LIMIT_PATTERN.test(raw) || Number(raw) > MAX_LIST_LIMIT) {
        throw new OperatorUsageError(`--${flag} must be an integer between 1 and ${MAX_LIST_LIMIT}`);
      }

      return Number(raw);
  }
}

/**
 * Strict `--flag value` / `--switch` parsing: unknown flags, positional
 * arguments, repeated flags, missing values and missing required flags are
 * rejected. No `--flag=value`, no abbreviations.
 */
export function parseOperatorArguments<S extends Record<string, OperatorFlagKind>>(
  argv: readonly string[],
  spec: S,
  required: readonly (keyof S & string)[] = []
): ParsedOperatorArguments<S> {
  const parsed: Record<string, string | number | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const flag = token.startsWith("--") ? token.slice(2) : null;

    if (flag === null || !Object.hasOwn(spec, flag)) {
      throw new OperatorUsageError(flag === null ? "unexpected positional argument" : "unknown flag");
    }

    if (Object.hasOwn(parsed, flag)) {
      throw new OperatorUsageError(`--${flag} given more than once`);
    }

    const kind = spec[flag]!;

    if (kind === "switch") {
      parsed[flag] = true;
      continue;
    }

    const raw = argv[index + 1];

    if (raw === undefined || raw.startsWith("--")) {
      throw new OperatorUsageError(`--${flag} requires a value`);
    }

    parsed[flag] = parseValue(flag, kind, raw);
    index += 1;
  }

  for (const flag of required) {
    if (!Object.hasOwn(parsed, flag)) {
      throw new OperatorUsageError(`--${flag} is required`);
    }
  }

  return parsed as ParsedOperatorArguments<S>;
}

export type OperatorPrincipalRejection = "malformed" | "reserved" | "unknown" | "not_operator";

/**
 * W6: the principal an operator action is attributed to must be a registered
 * principal of type `operator` in the active registry (presence in the
 * registry is what "active" means: it has a live credential). Never `system`
 * or `legacy-v1`, never a service principal, never merely a well-formed id.
 */
export function resolveOperatorPrincipal(
  registry: Pick<PrincipalRegistry, "find">,
  principalId: string
): { readonly ok: true; readonly principalId: string } | { readonly ok: false; readonly reason: OperatorPrincipalRejection } {
  if (!PRINCIPAL_ID_PATTERN.test(principalId)) {
    return { ok: false, reason: "malformed" };
  }

  if ((RESERVED_PRINCIPAL_IDS as readonly string[]).includes(principalId)) {
    return { ok: false, reason: "reserved" };
  }

  const principal = registry.find(principalId);

  if (principal === null) {
    return { ok: false, reason: "unknown" };
  }

  return principal.principalType === "operator" ? { ok: true, principalId } : { ok: false, reason: "not_operator" };
}

/** The refusal every operator command returns for a principal that fails W6. */
export const operatorRejected = (reason: OperatorPrincipalRejection): OperatorResult => ({
  exitCode: OPERATOR_EXIT.REFUSED,
  body: { status: "refused", reason: "OPERATOR_PRINCIPAL_REJECTED", principalCheck: reason }
});

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Runs `work` against the runtime database only when it is reachable and its
 * schema is exactly the head this build was written against, with verified
 * migration checksums (the readiness rule). Anything else fails closed
 * before any query of `work` runs.
 */
export async function withOperatorDatabase(
  env: AppEnv,
  work: (database: PostgresDatabase) => Promise<OperatorResult>
): Promise<OperatorResult> {
  const manifest = loadMigrationManifest();
  const probe = await new PostgresDependencyProbe(buildConnectionConfig(env), manifest).probe(PROBE_TIMEOUT_MS);

  if (!probe.connection.ok) {
    return {
      exitCode: OPERATOR_EXIT.FAILED,
      body: { status: "database_unavailable", category: probe.connection.failureCategory }
    };
  }

  if (probe.schema.state !== "READY") {
    return {
      exitCode: OPERATOR_EXIT.REFUSED,
      body: { status: "schema_incompatible", schemaState: probe.schema.state, expectedHead: manifest.expectedHead, actualHead: probe.schema.actualHead }
    };
  }

  const database = new PostgresDatabase(env);

  try {
    return await work(database);
  } finally {
    await database.close();
  }
}
