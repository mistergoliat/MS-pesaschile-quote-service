import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { verifyDocumentArtifacts } from "../../src/infrastructure/documents/document-artifact-verifier";
import { MIGRATION_MANIFEST } from "../../src/infrastructure/persistence/postgres/migration-manifest";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { PostgresDependencyProbe } from "../../src/infrastructure/persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../../src/infrastructure/persistence/postgres/schema-head";
import { createTestDatabase, type TestDatabaseHandle } from "../helpers/test-database";
import { migrateToV1Head, seedV1Snapshot, V1_DELIVERIES, V1_IDS, V1_PDF_BYTES, V1_QUOTES, V1_RAW_IDEMPOTENCY_KEYS } from "../helpers/v1-fixture";

/*
 * R1.6D — synthetic V1 → V2 migration rehearsal (pre-flight audit §31 R1.6D,
 * QUOTE_V2_V1_MIGRATION.md). It does NOT reimplement the migration: it seeds
 * the established synthetic V1 fixture (test/helpers/v1-fixture.ts) into
 * DISPOSABLE databases on the local test PostgreSQL (created and dropped
 * here), runs the real migrator (000001 → 000009) and reconciles the result
 * against the historical mapping contract. A second fixture with an
 * unsupported legacy row must fail closed with a deterministic exception
 * report and no partial V2 dataset.
 *
 * Rerunnable: `npm run rehearsal:migration` runs this file with
 * QUOTE_MIGRATION_REHEARSAL_REPORT set and writes the committed report.
 * Plain `npm test` runs the same checks without writing anything.
 * No production or shared database is touched; no credential is recorded.
 */

const TEST_TIMEOUT_MS = 180_000;
const REPORT_PATH = process.env.QUOTE_MIGRATION_REHEARSAL_REPORT;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 60_000);

interface Check {
  readonly group: string;
  readonly name: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const passed = (check: Check) => isDeepStrictEqual(check.actual, check.expected);

async function disposable(): Promise<TestDatabaseHandle> {
  const handle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => handle.dispose());
  return handle;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  cleanups.push(() => client.end());
  return client;
}

async function scalar<T>(client: pg.Client, sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<{ v: T }>(sql, values);
  return rows[0]!.v;
}

async function counts(client: pg.Client, tables: readonly string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  for (const table of tables) {
    result[table] = await scalar<number>(client, `select count(*)::int as v from quote_service.${table}`);
  }

  return result;
}

/** Canonical content of every V2 table, excluding run-time stamps: equal across reruns iff the migration is deterministic. */
async function contentDigest(client: pg.Client): Promise<string> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'quote_service' order by table_name`
  );
  const hash = crypto.createHash("sha256");

  for (const { table_name: table } of tables) {
    const data = await scalar<unknown>(
      client,
      `select coalesce(jsonb_agg(to_jsonb(t) - 'migrated_at' - 'recorded_at' - 'recorded_by' order by to_jsonb(t)::text), '[]') as v
       from quote_service.${table} t`
    );
    hash.update(`${table}\n${JSON.stringify(data)}\n`);
  }

  return hash.digest("hex");
}

const V1_TABLES = ["quotes", "quote_lines", "quote_audit_events", "quote_deliveries", "quote_email_outbox", "idempotency_keys"] as const;
const V2_TABLES = [
  "quotes", "quote_lines", "quote_shipping", "issuance_operations", "quote_documents", "quote_audit_events",
  "quote_deliveries", "idempotency_bindings", "quote_legacy_v1", "schema_migration_checksums"
] as const;

/** The historical mapping contract (QUOTE_V2_V1_MIGRATION.md), per fixture quote. */
const EXPECTED_STATES: Record<string, string> = {
  [V1_IDS.draft]: "draft",
  [V1_IDS.issued]: "issued",
  [V1_IDS.accepted]: "issued",
  [V1_IDS.paid]: "issued",
  [V1_IDS.cancelledIssued]: "cancelled",
  [V1_IDS.cancelledDraft]: "cancelled",
  [V1_IDS.expired]: "expired",
  [V1_IDS.revision]: "draft"
};
const EXPECTED_DELIVERIES: Record<string, { status: string; code: string | null }> = {
  [V1_DELIVERIES.sent]: { status: "sent", code: null },
  [V1_DELIVERIES.pending]: { status: "failed", code: "superseded_by_v2_migration" },
  [V1_DELIVERIES.processing]: { status: "unknown", code: null },
  [V1_DELIVERIES.failed]: { status: "failed", code: "legacy_v1_delivery_failed" }
};

async function rehearseSuccess(): Promise<{ checks: Check[]; before: Record<string, number>; after: Record<string, number>; digest: string; postgres: string }> {
  const handle = await disposable();
  await migrateToV1Head(handle.connectionString);
  await seedV1Snapshot(handle.connectionString);
  const client = await connect(handle.connectionString);
  const before = await counts(client, V1_TABLES);
  const postgres = await scalar<string>(client, `select current_setting('server_version') as v`);
  const v1Issued = await scalar<number>(client, `select count(*)::int as v from quote_service.quotes where issued_pdf_sha256 is not null`);

  await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
  const after = await counts(client, V2_TABLES);
  const checks: Check[] = [];
  const check = (group: string, name: string, expected: unknown, actual: unknown) => checks.push({ group, name, expected, actual });

  // Counts reconcile (BJ).
  check("counts", "quotes: V1 rows = V2 rows", before.quotes, after.quotes);
  check("counts", "lines: V1 rows = V2 rows", before.quote_lines, after.quote_lines);
  check("counts", "deliveries: V1 rows = V2 rows", before.quote_deliveries, after.quote_deliveries);
  check("counts", "document manifests = V1 issued PDFs", v1Issued, after.quote_documents);
  check("counts", "legacy evidence rows = V1 quotes", before.quotes, after.quote_legacy_v1);
  check("counts", "synthetic succeeded operations = manifests", after.quote_documents, after.issuance_operations);
  check("counts", "completed V1 idempotency rows → legacy bindings", 3, after.idempotency_bindings);
  check("counts", "V1 audit events preserved (+1 derived acceptance)", before.quote_audit_events! + 1, after.quote_audit_events);

  // State mapping (BI).
  const { rows: states } = await client.query<{ quote_id: string; status: string }>(`select quote_id, status from quote_service.quotes order by quote_id`);
  check("mapping", "quote state mapping (accepted/paid → issued; no V1-only state)", EXPECTED_STATES, Object.fromEntries(states.map((row) => [row.quote_id, row.status])));
  const expectedLines = V1_QUOTES.flatMap((quote) => quote.lines.map((line, index) => ({
    line_id: `30000000-0000-4000-8000-${quote.id.slice(-2)}${String(index + 1).padStart(10, "0")}`,
    quote_id: quote.id,
    position: index + 1,
    kind: line.type === "shipping" ? "service" : line.type,
    item_source_system: line.type === "shipping" ? "legacy-v1-shipping" : line.externalSource ?? "legacy-v1",
    item_product_ref: line.externalItemId ?? null,
    item_variant_ref: line.externalVariantId ?? null,
    item_sku: line.sku ?? null,
    item_description: line.description
  }))).sort((a, b) => a.quote_id.localeCompare(b.quote_id) || a.position - b.position);
  const { rows: mappedLines } = await client.query<{
    line_id: string; quote_id: string; position: number; kind: string; item_source_system: string;
    item_product_ref: string | null; item_variant_ref: string | null; item_sku: string | null; item_description: string;
  }>(`select line_id, quote_id, position, kind, item_source_system, item_product_ref, item_variant_ref, item_sku, item_description
      from quote_service.quote_lines order by quote_id, position`);
  check("mapping", "line identity and fields preserved (position, kind, source, references, SKU, description)", expectedLines, mappedLines);
  check("mapping", "issued numbers preserved", V1_QUOTES.filter((quote) => quote.issued).map((quote) => quote.number).sort(),
    (await client.query<{ quote_number: string }>(`select quote_number from quote_service.quotes where quote_number is not null order by quote_number`)).rows.map((row) => row.quote_number));

  // opportunityId → externalCorrelation.
  const { rows: correlations } = await client.query<{ quote_id: string; external_reference_type: string; external_reference: string }>(
    `select quote_id, external_reference_type, external_reference from quote_service.quotes order by quote_id`
  );
  check("mapping", "opportunityId → externalCorrelation (type opportunity)",
    Object.fromEntries(V1_QUOTES.map((quote) => [quote.id, `opportunity:${quote.opportunityId}`])),
    Object.fromEntries(correlations.map((row) => [row.quote_id, `${row.external_reference_type}:${row.external_reference}`])));

  // Delivery mapping (BK).
  const { rows: deliveries } = await client.query<{ delivery_id: string; status: string; last_error_code: string | null }>(
    `select delivery_id, status, last_error_code from quote_service.quote_deliveries order by delivery_id`
  );
  check("mapping", "delivery state mapping", EXPECTED_DELIVERIES, Object.fromEntries(deliveries.map((row) => [row.delivery_id, { status: row.status, code: row.last_error_code }])));
  check("mapping", "no migrated delivery can still be sent", 0, await scalar<number>(client, `select count(*)::int as v from quote_service.quote_deliveries where status in ('pending', 'sending')`));

  // Documents and legacy metadata (BL).
  const { rows: documents } = await client.query<{ quote_id: string; pdf_sha256: string; origin: string }>(`select quote_id, pdf_sha256, origin from quote_service.quote_documents order by quote_id`);
  check("documents", "manifest hashes equal the V1 PDF hashes",
    Object.fromEntries(Object.entries(V1_PDF_BYTES).map(([quoteId, bytes]) => [quoteId, crypto.createHash("sha256").update(bytes).digest("hex")]).sort()),
    Object.fromEntries(documents.map((row) => [row.quote_id, row.pdf_sha256]).sort()));
  check("documents", "every migrated manifest is origin legacy_v1", true, documents.every((row) => row.origin === "legacy_v1"));
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-rehearsal-artifacts-"));
  cleanups.push(() => fsPromises.rm(root, { recursive: true, force: true }));
  const { rows: keys } = await client.query<{ quote_id: string; storage_key: string }>(`select quote_id, storage_key from quote_service.quote_documents`);
  for (const key of keys) {
    const target = path.join(root, key.storage_key);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, V1_PDF_BYTES[key.quote_id]!);
  }
  const verified = await verifyDocumentArtifacts({ database: client, store: new FilesystemContentAddressedArtifactStore(root), recordLegacyByteLength: false });
  check("documents", "relocated V1 artifacts verify byte-for-byte (documents:verify semantics)", { checked: documents.length, ok: documents.length }, { checked: verified.checked, ok: verified.ok });
  const everything = JSON.stringify((await client.query(
    `select (select jsonb_agg(to_jsonb(b)) from quote_service.idempotency_bindings b) as bindings,
            (select jsonb_agg(to_jsonb(a)) from quote_service.quote_audit_events a) as audit,
            (select jsonb_agg(to_jsonb(l)) from quote_service.quote_legacy_v1 l) as legacy`
  )).rows);
  check("documents", "no raw V1 idempotency key survives", true, Object.values(V1_RAW_IDEMPOTENCY_KEYS).every((key) => !everything.includes(key)));

  // Schema head and checksum integrity (BM).
  const probe = await new PostgresDependencyProbe({ connectionString: handle.connectionString }, loadMigrationManifest()).probe(5_000);
  check("schema", "schema state and head", { state: "READY", actualHead: MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]!.name }, probe.schema);
  const { rows: checksums } = await client.query<{ name: string; sha256: string }>(`select name, sha256 from quote_service.schema_migration_checksums order by name`);
  check("schema", "recorded checksums = packaged manifest", MIGRATION_MANIFEST.map((entry) => ({ name: entry.name, sha256: entry.sha256 })), checksums);

  return { checks, before, after, digest: await contentDigest(client), postgres };
}

async function rehearseException(): Promise<{ message: string; checks: Check[] }> {
  const handle = await disposable();
  await migrateToV1Head(handle.connectionString);
  // Unsupported legacy data: a line description over the V2 limit (301 characters).
  await seedV1Snapshot(handle.connectionString, { overrideDescription: { quoteId: V1_IDS.issued, description: "x".repeat(301) } });
  const client = await connect(handle.connectionString);
  const before = await counts(client, V1_TABLES);
  const failure = await runMigrations({ databaseUrl: handle.connectionString, direction: "up" }).then(
    () => null,
    (error: unknown) => error as Error
  );
  const message = failure?.message ?? "";
  const probe = await new PostgresDependencyProbe({ connectionString: handle.connectionString }, loadMigrationManifest()).probe(5_000);
  const checks: Check[] = [
    { group: "exception", name: "migration refused", expected: true, actual: failure instanceof Error },
    { group: "exception", name: "exception report names the row and reason", expected: true, actual: message.includes("V1 -> V2 migration exceptions: 1 row(s)") && message.includes(`${V1_IDS.issued} line_description_invalid`) },
    { group: "exception", name: "exception report carries no row content", expected: false, actual: message.includes("xxxxxxxxxx") },
    { group: "exception", name: "V1 data untouched (row counts)", expected: before, actual: await counts(client, V1_TABLES) },
    {
      group: "exception",
      name: "no partial V2 dataset (V2-only tables absent)",
      expected: { issuance_operations: null, quote_documents: null, idempotency_bindings: null, quote_legacy_v1: null },
      actual: await scalar(client, `select jsonb_build_object(
          'issuance_operations', to_regclass('quote_service.issuance_operations'),
          'quote_documents', to_regclass('quote_service.quote_documents'),
          'idempotency_bindings', to_regclass('quote_service.idempotency_bindings'),
          'quote_legacy_v1', to_regclass('quote_service.quote_legacy_v1')) as v`)
    },
    { group: "exception", name: "schema stays at the V1 head (not ready)", expected: { state: "SCHEMA_BEHIND", actualHead: "000005_quote_line_shipping" }, actual: probe.schema }
  ];
  return { message, checks };
}

function gitHead(): { head: string; branch: string; dirty: boolean } {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { head, branch, dirty };
  } catch {
    return { head: "unknown", branch: "unknown", dirty: true };
  }
}

function writeReport(input: {
  success: Awaited<ReturnType<typeof rehearseSuccess>>;
  rerunDigest: string;
  exception: Awaited<ReturnType<typeof rehearseException>>;
  exceptionRerunMessage: string;
  checks: Check[];
}): void {
  const { head, branch, dirty } = gitHead();
  const fixtureSource = fs.readFileSync(path.resolve("test/helpers/v1-fixture.ts"), "utf8").replace(/\r\n/g, "\n");
  const fixtureSha = crypto.createHash("sha256").update(fixtureSource).digest("hex");
  const verdict = input.checks.every(passed) ? "PASS" : "FAIL";
  const row = (check: Check) => `| ${check.group} | ${check.name} | ${passed(check) ? "PASS" : "**FAIL**"} |`;
  const table = (values: Record<string, number>) => Object.entries(values).map(([name, count]) => `| \`${name}\` | ${count} |`).join("\n");
  const exceptionLines = input.exception.message.split("\n").map((line) => `    ${line}`).join("\n");

  const report = `# R1.6D — Synthetic V1 → V2 Migration Rehearsal

Generated by \`npm run rehearsal:migration\`
(\`test/integration/migration-rehearsal.integration.test.ts\`). Do not edit by
hand; rerun the command instead.

**Result: ${verdict}**

No production, staging or shared database was used. Every database was
created for this run on the local disposable test PostgreSQL and dropped
afterwards. The fixture is synthetic. No credential, connection string or
generated secret is recorded here.

## Environment

| Item | Value |
|---|---|
| Implementation HEAD tested | \`${head}\` |
| Repository state before rehearsal | ${dirty ? "dirty" : "clean"} |
| Branch | \`${branch}\` |
| Node | \`${process.version}\` |
| PostgreSQL | \`${input.success.postgres}\` |
| Migration head (expected) | \`${MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]!.name}\` |
| Migrations applied | ${MIGRATION_MANIFEST.length} (\`000001\` → \`000009\`) |
| Fixture | \`test/helpers/v1-fixture.ts\` (LF-normalized SHA-256 \`${fixtureSha}\`) |
| Fixture content | ${V1_QUOTES.length} V1 quotes (draft, issued, accepted, paid, cancelled-after-issue, cancelled draft, expired, revision draft), 4 deliveries, 5 idempotency rows |

## Supported fixture — counts

V1 (before, at \`000005\`):

| Table | Rows |
|---|---|
${table(input.success.before)}

V2 (after, at the expected head):

| Table | Rows |
|---|---|
${table(input.success.after)}

## Checks

| Group | Check | Result |
|---|---|---|
${input.checks.map(row).join("\n")}

## Exception fixture

An unsupported legacy row (a line description over the V2 limit) was seeded
on an otherwise identical fixture. The migration refused it inside its
transaction. Exception report (identical on a second independent run:
${input.exception.message === input.exceptionRerunMessage ? "yes" : "**no**"}):

${exceptionLines}

## Reproducibility

Two independent rehearsals (fresh databases, same fixture) produced the same
canonical V2 content digest (all \`quote_service\` tables, run-time stamps
excluded): ${input.success.digest === input.rerunDigest ? "yes" : "**no**"}.

\`${input.success.digest}\`

## Scope

This proves the existing migration tooling (\`000007\`) still converts the
supported synthetic V1 shapes exactly and fails closed on unsupported data.
The real-data rehearsal, legacy artifact relocation and the production V1
cutover are R1.7.
`;

  fs.mkdirSync(path.dirname(path.resolve(REPORT_PATH!)), { recursive: true });
  fs.writeFileSync(path.resolve(REPORT_PATH!), report, "utf8");
}

describe("synthetic V1 → V2 migration rehearsal (BI-BP)", () => {
  it("migrates the supported fixture exactly, fails closed on the exception fixture, and is reproducible", async () => {
    const success = await rehearseSuccess();
    const rerun = await rehearseSuccess();
    const exception = await rehearseException();
    const exceptionRerun = await rehearseException();
    const checks: Check[] = [
      ...success.checks,
      ...exception.checks,
      { group: "reproducibility", name: "rerun produces identical V2 content", expected: success.digest, actual: rerun.digest },
      { group: "reproducibility", name: "rerun produces identical exception report", expected: exception.message, actual: exceptionRerun.message }
    ];

    if (REPORT_PATH) {
      writeReport({ success, rerunDigest: rerun.digest, exception, exceptionRerunMessage: exceptionRerun.message, checks });
    }

    for (const check of checks) {
      expect(check.actual, `${check.group}: ${check.name}`).toEqual(check.expected);
    }
  }, TEST_TIMEOUT_MS);
});
