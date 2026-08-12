import { z } from "zod";

function booleanEnvSchema(defaultValue: boolean) {
  return z
    .preprocess((value) => {
      if (value === undefined) {
        return undefined;
      }

      if (typeof value === "boolean") {
        return value;
      }

      if (typeof value === "string") {
        return value.trim().toLowerCase();
      }

      return value;
    }, z.union([z.boolean(), z.enum(["true", "false"])]))
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return defaultValue;
      }

      return value === true || value === "true";
    });
}

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
  SERVICE_AUTH_TOKEN: z.string().min(1),
  HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  QUOTE_COMPANY_NAME: z.string().min(1).default("Pesas Chile SPA"),
  QUOTE_DOCUMENT_STORAGE_ROOT: z.string().min(1),
  QUOTE_DOCUMENT_REF_SECRET: z.string().min(16),
  QUOTE_RENDER_VERSION: z.string().min(1).default("quote-v1"),
  QUOTE_PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  QUOTE_PDF_EXECUTABLE_PATH: z.string().min(1).optional(),
  QUOTE_EXPIRATION_SCHEDULER_ENABLED: booleanEnvSchema(false),
  QUOTE_EXPIRATION_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  QUOTE_EXPIRATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  QUOTE_DOCUMENT_CLEANUP_ENABLED: booleanEnvSchema(false),
  QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  QUOTE_EMAIL_PROVIDER: z.enum(["disabled", "gmail"]).default("disabled"),
  QUOTE_EMAIL_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  QUOTE_EMAIL_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  QUOTE_EMAIL_DELIVERY_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  QUOTE_EMAIL_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  QUOTE_EMAIL_FROM_ADDRESS: z.string().trim().min(1).optional(),
  QUOTE_EMAIL_FROM_NAME: z.string().trim().min(1).optional(),
  QUOTE_EMAIL_REPLY_TO: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_CLIENT_SECRET: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_REFRESH_TOKEN: z.string().trim().min(1).optional(),
  GOOGLE_GMAIL_USER: z.string().trim().min(1).optional()
})
  .superRefine((env, context) => {
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

    if (env.NODE_ENV !== "production") {
      return;
    }

    const insecureAuthTokens = new Set(["replace-me", "token", "changeme"]);
    const insecureDocumentSecrets = new Set([
      "replace-with-a-long-secret",
      "test-document-secret",
      "changemechangeme"
    ]);

    if (env.SERVICE_AUTH_TOKEN.length < 16 || insecureAuthTokens.has(env.SERVICE_AUTH_TOKEN)) {
      context.addIssue({
        code: "custom",
        path: ["SERVICE_AUTH_TOKEN"],
        message: "SERVICE_AUTH_TOKEN is too weak for production"
      });
    }

    if (
      env.QUOTE_DOCUMENT_REF_SECRET.length < 32 ||
      insecureDocumentSecrets.has(env.QUOTE_DOCUMENT_REF_SECRET)
    ) {
      context.addIssue({
        code: "custom",
        path: ["QUOTE_DOCUMENT_REF_SECRET"],
        message: "QUOTE_DOCUMENT_REF_SECRET is too weak for production"
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}
