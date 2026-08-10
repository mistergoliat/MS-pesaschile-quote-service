import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  DATABASE_SSL_MODE: z.enum(["disable", "require"]).default("disable"),
  SERVICE_NAME: z.string().min(1).default("pesaschile-quote-service"),
  SERVICE_VERSION: z.string().min(1).default("0.1.0"),
  SERVICE_AUTH_TOKEN: z.string().min(1),
  HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  QUOTE_COMPANY_NAME: z.string().min(1).default("Pesas Chile SPA"),
  QUOTE_DOCUMENT_STORAGE_ROOT: z.string().min(1),
  QUOTE_DOCUMENT_REF_SECRET: z.string().min(16),
  QUOTE_RENDER_VERSION: z.string().min(1).default("quote-v1"),
  QUOTE_PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  QUOTE_PDF_EXECUTABLE_PATH: z.string().min(1).optional()
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}
