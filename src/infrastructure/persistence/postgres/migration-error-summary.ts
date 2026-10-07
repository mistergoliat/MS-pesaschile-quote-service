import { safeErrorSummary } from "../../../application/safe-error";
import { MigrationIntegrityError } from "./migrator";
import { MIGRATION_MANIFEST } from "./migration-manifest";

const EXCEPTION_CODES = new Set([
  "issued_without_issued_at", "document_missing", "document_metadata_invalid",
  "cancelled_without_cancelled_at", "expired_without_expired_at", "validity_not_after_issue",
  "quote_number_invalid", "external_reference_invalid", "customer_field_invalid",
  "line_description_invalid", "line_sku_invalid", "line_source_system_invalid",
  "line_item_reference_invalid", "line_quantity_out_of_range", "line_unit_amount_out_of_range",
  "line_tax_rate_out_of_range", "line_arithmetic_mismatch", "totals_arithmetic_mismatch",
  "totals_out_of_range", "line_count_out_of_range", "idempotency_request_hash_invalid",
  "idempotency_resource_unresolved", "delivery_without_document", "delivery_sent_without_sent_at"
]);

/** Recognize 000007's report envelope, then retain ONLY its allowlisted codes and UUIDs. */
export function migrationErrorSummary(error: unknown): Record<string, unknown> {
  try {
    return describeMigrationError(error);
  } catch {
    return safeErrorSummary(error);
  }
}

function describeMigrationError(error: unknown): Record<string, unknown> {
  const summary = safeErrorSummary(error);
  if (error instanceof MigrationIntegrityError) {
    // Re-select from the code-owned manifest; database names never become output authority.
    const migrationNames = MIGRATION_MANIFEST.map((entry) => entry.name).filter((name) => error.migrationNames.includes(name));
    return { ...summary, phase: "checksum_verification", migrationNames, schemaStatus: "SCHEMA_INTEGRITY_MISMATCH" };
  }
  if (summary.errorCode !== "P0001" || typeof error !== "object" || error === null) return summary;
  let message: unknown;
  try { message = Object.getOwnPropertyDescriptor(error, "message")?.value as unknown; } catch { return summary; }
  if (typeof message !== "string" || message.length > 64 * 1024) return summary;
  const header = /^V1 -> V2 migration exceptions: ([1-9][0-9]{0,9}) row\(s\) violate the frozen mapping; nothing was migrated\.\n/.exec(message);
  if (!header) return summary;
  const exceptions: Array<{ quoteId: string | null; exceptionCode: string }> = [];
  for (const line of message.slice(header[0].length).split("\n").slice(0, 100)) {
    const row = /^ {2}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-) ([a-z_]+)(?: |$)/.exec(line);
    if (row && EXCEPTION_CODES.has(row[2]!)) exceptions.push({ quoteId: row[1] === "-" ? null : row[1]!, exceptionCode: row[2]! });
  }
  return { ...summary, migrationName: "000007_quote_v2_persistence", exceptionCount: Number(header[1]), exceptions };
}
