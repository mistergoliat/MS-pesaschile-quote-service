import path from "node:path";

/** Packaged migration files (copied to dist/ by scripts/copy-migrations.cjs). */
export const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "migrations");

/** node-pg-migrate bookkeeping table (names only), in schema public. */
export const MIGRATIONS_TABLE = "schema_migrations";
