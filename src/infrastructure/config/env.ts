import { z } from "zod";

import { isStrictMailbox } from "../../application/quote-v2/delivery/strict-mailbox";

/** Kept between the end of a provider call and delivery lease expiry, for recording the outcome. */
export const DELIVERY_COMPLETION_MARGIN_MS = 10_000;
/** Upper bound of reading a committed PDF before a send attempt. */
export const DELIVERY_DOCUMENT_READ_TIMEOUT_MS = 10_000;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;

const envSchema = z
  .object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10 * 1024 * 1024).default(1024 * 1024),
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  HTTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(5_000),
  APP_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL_MODE: z.enum(["disable", "require"]).default("disable"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(5_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  SERVICE_NAME: z.string().min(1).default("pesaschile-quote-service"),
  SERVICE_VERSION: z.string().min(1).default("0.1.0"),
  // Principal registry (docs/principals.md): exactly one of a file path
  // (reloadable on SIGHUP) or inline JSON injected by the secret store.
  // The V1 SERVICE_AUTH_TOKEN is retired and maps to no principal.
  QUOTE_PRINCIPAL_REGISTRY_FILE: z.string().trim().min(1).optional(),
  QUOTE_PRINCIPAL_REGISTRY_JSON: z.string().trim().min(1).optional(),
  // Deprecated alias for HEALTH_PROBE_TIMEOUT_MS; used only when the new key is unset.
  HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).optional(),
  HEALTH_PROBE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  HEALTH_PROBE_RETRY_MIN_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  HEALTH_PROBE_RETRY_MAX_MS: z.coerce.number().int().min(50).max(300_000).default(30_000),
  // Legacy email smoke/preview scripts only (R1.6). The formal PDF takes its
  // issuer identity from the code-owned issuer profile, never from here.
  QUOTE_COMPANY_NAME: z.string().min(1).default("Pesas Chile SPA"),
  QUOTE_DOCUMENT_STORAGE_ROOT: z.string().min(1),
  // Issuance operation (Idempotency §4.2): defaults and ranges are the
  // contract's. The deadline is copied onto each operation at acceptance.
  // The sync budget is implementation configuration, not an API invariant
  // (amendment A2).
  QUOTE_ISSUANCE_LEASE_MS: z.coerce.number().int().min(10_000).max(300_000).default(60_000),
  QUOTE_ISSUANCE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  QUOTE_ISSUANCE_DEADLINE_MS: z.coerce.number().int().min(3_600_000).max(259_200_000).default(86_400_000),
  QUOTE_ISSUANCE_SYNC_BUDGET_MS: z.coerce.number().int().min(0).max(10_000).default(5_000),
  // V2 email delivery (R1.6B). `disabled` (default): no sender, no send
  // runner, new delivery requests answer 503 email_provider; the persistence
  // expired-lease sweep still runs. `gmail`: the Gmail adapter and the send
  // runner are composed. There is deliberately no `fake` value: a test sender
  // can only be injected through BuildApplicationOverrides.
  QUOTE_EMAIL_PROVIDER: z.enum(["disabled", "gmail"]).default("disabled"),
  // Delivery lease (no renewal): must exceed token + send timeouts plus the
  // completion margin; an attempt that outlives it becomes `unknown`.
  QUOTE_EMAIL_DELIVERY_LEASE_MS: z.coerce.number().int().min(15_000).max(600_000).default(120_000),
  QUOTE_EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(5_000),
  QUOTE_EMAIL_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
  QUOTE_EMAIL_SEND_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(30_000),
  QUOTE_EMAIL_FROM_ADDRESS: z.string().trim().min(1).optional(),
  QUOTE_EMAIL_FROM_NAME: z.string().trim().min(1).optional(),
  QUOTE_EMAIL_REPLY_TO: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_CLIENT_SECRET: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_REFRESH_TOKEN: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_USER: z.string().trim().min(1).optional()
})
  .superRefine((env, context) => {
    if (env.HEALTH_PROBE_RETRY_MIN_MS > env.HEALTH_PROBE_RETRY_MAX_MS) {
      context.addIssue({
        code: "custom",
        path: ["HEALTH_PROBE_RETRY_MIN_MS"],
        message: "HEALTH_PROBE_RETRY_MIN_MS must not exceed HEALTH_PROBE_RETRY_MAX_MS"
      });
    }

    if ((env.QUOTE_PRINCIPAL_REGISTRY_FILE === undefined) === (env.QUOTE_PRINCIPAL_REGISTRY_JSON === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["QUOTE_PRINCIPAL_REGISTRY_FILE"],
        message: "exactly one of QUOTE_PRINCIPAL_REGISTRY_FILE or QUOTE_PRINCIPAL_REGISTRY_JSON is required"
      });
    }

    if (env.QUOTE_EMAIL_PROVIDER === "gmail") {
      const requiredKeys = [
        "GOOGLE_GMAIL_CLIENT_ID",
        "GOOGLE_GMAIL_CLIENT_SECRET",
        "GOOGLE_GMAIL_REFRESH_TOKEN",
        "GOOGLE_GMAIL_USER",
        "QUOTE_EMAIL_FROM_ADDRESS",
        "QUOTE_EMAIL_FROM_NAME"
      ] as const;

      for (const key of requiredKeys) {
        if (env[key] === undefined) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when QUOTE_EMAIL_PROVIDER=gmail`
          });
        }
      }

      for (const key of ["QUOTE_EMAIL_FROM_ADDRESS", "QUOTE_EMAIL_REPLY_TO"] as const) {
        const value = env[key];

        if (value !== undefined && !isStrictMailbox(value)) {
          context.addIssue({ code: "custom", path: [key], message: `${key} must be exactly one bare mailbox` });
        }
      }

      if (env.QUOTE_EMAIL_FROM_NAME !== undefined && (env.QUOTE_EMAIL_FROM_NAME.length > 200 || CONTROL_CHARACTERS.test(env.QUOTE_EMAIL_FROM_NAME))) {
        context.addIssue({ code: "custom", path: ["QUOTE_EMAIL_FROM_NAME"], message: "QUOTE_EMAIL_FROM_NAME must be at most 200 characters without control characters" });
      }
    }

    if (env.QUOTE_EMAIL_DELIVERY_LEASE_MS <= env.QUOTE_EMAIL_TOKEN_TIMEOUT_MS + env.QUOTE_EMAIL_SEND_TIMEOUT_MS + DELIVERY_COMPLETION_MARGIN_MS) {
      context.addIssue({
        code: "custom",
        path: ["QUOTE_EMAIL_DELIVERY_LEASE_MS"],
        message: `QUOTE_EMAIL_DELIVERY_LEASE_MS must exceed QUOTE_EMAIL_TOKEN_TIMEOUT_MS + QUOTE_EMAIL_SEND_TIMEOUT_MS + ${DELIVERY_COMPLETION_MARGIN_MS}`
      });
    }
  })
  .transform((env) => ({
    ...env,
    HEALTH_PROBE_TIMEOUT_MS: env.HEALTH_PROBE_TIMEOUT_MS ?? env.HEALTHCHECK_DATABASE_TIMEOUT_MS
  }));

export type AppEnv = z.output<typeof envSchema>;

export interface IssuanceSettings {
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly deadlineMs: number;
  readonly syncBudgetMs: number;
}

export function issuanceSettings(env: AppEnv): IssuanceSettings {
  return {
    leaseMs: env.QUOTE_ISSUANCE_LEASE_MS,
    pollIntervalMs: env.QUOTE_ISSUANCE_POLL_INTERVAL_MS,
    deadlineMs: env.QUOTE_ISSUANCE_DEADLINE_MS,
    syncBudgetMs: env.QUOTE_ISSUANCE_SYNC_BUDGET_MS
  };
}

export interface DeliverySettings {
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly tokenTimeoutMs: number;
  readonly sendTimeoutMs: number;
}

export function deliverySettings(env: AppEnv): DeliverySettings {
  return {
    leaseMs: env.QUOTE_EMAIL_DELIVERY_LEASE_MS,
    pollIntervalMs: env.QUOTE_EMAIL_POLL_INTERVAL_MS,
    tokenTimeoutMs: env.QUOTE_EMAIL_TOKEN_TIMEOUT_MS,
    sendTimeoutMs: env.QUOTE_EMAIL_SEND_TIMEOUT_MS
  };
}

/** Gmail adapter configuration; only meaningful (and validated) when QUOTE_EMAIL_PROVIDER=gmail. */
export function gmailSettings(env: AppEnv): {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly from: { readonly address: string; readonly name: string | null };
  readonly replyTo: string | null;
  readonly tokenTimeoutMs: number;
  readonly sendTimeoutMs: number;
} {
  return {
    clientId: env.GOOGLE_GMAIL_CLIENT_ID!,
    clientSecret: env.GOOGLE_GMAIL_CLIENT_SECRET!,
    refreshToken: env.GOOGLE_GMAIL_REFRESH_TOKEN!,
    from: { address: env.QUOTE_EMAIL_FROM_ADDRESS!, name: env.QUOTE_EMAIL_FROM_NAME ?? null },
    replyTo: env.QUOTE_EMAIL_REPLY_TO ?? null,
    tokenTimeoutMs: env.QUOTE_EMAIL_TOKEN_TIMEOUT_MS,
    sendTimeoutMs: env.QUOTE_EMAIL_SEND_TIMEOUT_MS
  };
}

/**
 * Configuration for the explicit migration/schema commands only. The
 * migration connection may use a different (DDL-capable) role than the
 * runtime; the server never reads MIGRATION_DATABASE_URL.
 */
const migrationEnvSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  MIGRATION_DATABASE_URL: z.string().url().optional()
});

export interface MigrationEnv {
  readonly databaseUrl: string;
}

export function loadMigrationEnv(rawEnv: NodeJS.ProcessEnv = process.env): MigrationEnv {
  const env = migrationEnvSchema.parse(rawEnv);
  const databaseUrl = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["MIGRATION_DATABASE_URL"],
        message: "MIGRATION_DATABASE_URL or DATABASE_URL is required",
        input: undefined
      }
    ]);
  }

  return {
    databaseUrl
  };
}

/**
 * Sanitized description of a configuration failure: variable names and rule
 * messages only, never the offending values.
 */
export function describeConfigError(error: unknown): { readonly issues: Array<{ path: string; message: string }> } | null {
  if (!(error instanceof z.ZodError)) {
    return null;
  }

  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}

export function principalRegistrySource(
  env: Pick<AppEnv, "QUOTE_PRINCIPAL_REGISTRY_FILE" | "QUOTE_PRINCIPAL_REGISTRY_JSON">
): { readonly kind: "file"; readonly path: string } | { readonly kind: "inline"; readonly json: string } {
  return env.QUOTE_PRINCIPAL_REGISTRY_FILE !== undefined
    ? { kind: "file", path: env.QUOTE_PRINCIPAL_REGISTRY_FILE }
    : { kind: "inline", json: env.QUOTE_PRINCIPAL_REGISTRY_JSON! };
}
