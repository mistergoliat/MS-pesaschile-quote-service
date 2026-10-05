import { z } from "zod";

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
  QUOTE_COMPANY_NAME: z.string().min(1).default("Pesas Chile SPA"),
  QUOTE_DOCUMENT_STORAGE_ROOT: z.string().min(1),
  QUOTE_RENDER_VERSION: z.string().min(1).default("quote-pdf-v3"),
  // Email provider configuration, used only by the email smoke script until
  // the V2 delivery subsystem (R1.6). The V1 expiry, cleanup and email worker
  // settings were retired with the V1 runtime in R1.4.
  QUOTE_EMAIL_PROVIDER: z.enum(["disabled", "gmail"]).default("disabled"),
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
    }
  })
  .transform((env) => ({
    ...env,
    HEALTH_PROBE_TIMEOUT_MS: env.HEALTH_PROBE_TIMEOUT_MS ?? env.HEALTHCHECK_DATABASE_TIMEOUT_MS
  }));

export type AppEnv = z.output<typeof envSchema>;

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
