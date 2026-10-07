import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { verifyDocumentArtifacts } from "../../src/infrastructure/documents/document-artifact-verifier";
import { MIGRATION_MANIFEST } from "../../src/infrastructure/persistence/postgres/migration-manifest";
import { MigrationIntegrityError, runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { PostgresDependencyProbe } from "../../src/infrastructure/persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../../src/infrastructure/persistence/postgres/schema-head";
import { createTestDatabase, type TestDatabaseHandle } from "../helpers/test-database";
import {
  migrateToV1Head,
  seedV1Snapshot,
  sha256Hex,
  V1_DELIVERIES,
  V1_IDS,
  V1_PDF_BYTES,
  V1_RAW_IDEMPOTENCY_KEYS
} from "../helpers/v1-fixture";

const TEST_TIMEOUT_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

async function database(): Promise<TestDatabaseHandle> {
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

async function migratedV1Database(): Promise<{ handle: TestDatabaseHandle; client: pg.Client }> {
  const handle = await database();
  await migrateToV1Head(handle.connectionString);
  await seedV1Snapshot(handle.connectionString);
  await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
  return { handle, client: await connect(handle.connectionString) };
}

async function rows<T extends pg.QueryResultRow>(client: pg.Client, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

async function probeSchema(url: string) {
  return new PostgresDependencyProbe({ connectionString: url }, loadMigrationManifest()).probe(5_000);
}

/** Every table's rows as canonical JSON, excluding run-time-of-migration stamps. */
async function snapshotDatabase(client: pg.Client): Promise<Record<string, unknown>> {
  const tables = await rows<{ table_name: string }>(
    client,
    `select table_name from information_schema.tables where table_schema = 'quote_service' order by table_name`
  );
  const result: Record<string, unknown> = {};

  for (const { table_name: table } of tables) {
    const data = await rows<{ data: unknown }>(
      client,
      `select coalesce(jsonb_agg(to_jsonb(t) - 'migrated_at' - 'recorded_at' - 'recorded_by' order by to_jsonb(t)::text), '[]') as data
       from quote_service.${table} t`
    );
    result[table] = data[0]!.data;
  }

  result.schema = await rows(
    client,
    `select table_name, column_name, data_type, is_nullable, column_default, numeric_precision, numeric_scale
     from information_schema.columns where table_schema = 'quote_service' order by table_name, column_name`
  );
  result.constraints = await rows(
    client,
    `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
     from pg_constraint where connamespace = 'quote_service'::regnamespace order by 1, 2`
  );
  result.indexes = await rows(
    client,
    `select indexname, indexdef from pg_indexes where schemaname = 'quote_service' order by indexname`
  );
  result.triggers = await rows(
    client,
    `select tgrelid::regclass::text as tbl, tgname from pg_trigger
     where not tgisinternal and tgrelid::regclass::text like 'quote_service.%' order by 1, 2`
  );
  result.sequence = await rows(client, `select last_value, is_called from quote_service.quote_number_seq`);

  return result;
}

describe("V2 migration: fresh database (A, Q, S)", () => {
  it("A/Q: migrates an empty database to the expected head with recorded checksums, readiness READY", async () => {
    const handle = await database();
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    const client = await connect(handle.connectionString);

    expect((await probeSchema(handle.connectionString)).schema).toEqual({
      state: "READY",
      actualHead: "000009_quote_snapshot_child_insert_guard"
    });
    const checksums = await rows<{ name: string; sha256: string; provenance: string }>(
      client,
      `select name, sha256, provenance from quote_service.schema_migration_checksums order by name`
    );
    expect(checksums).toEqual(MIGRATION_MANIFEST.map((entry) => ({ ...entry, provenance: "applied" })));
    expect((await rows(client, `select to_regclass('quote_service.quote_email_outbox') as t`))[0]).toEqual({ t: null });
  }, TEST_TIMEOUT_MS);

  it("C (rerun): migration tooling can be rerun safely", async () => {
    const handle = await database();
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    const client = await connect(handle.connectionString);
    const before = await snapshotDatabase(client);

    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });

    expect(await snapshotDatabase(client)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it("S: migration from an empty database is deterministic", async () => {
    const first = await database();
    const second = await database();
    await runMigrations({ databaseUrl: first.connectionString, direction: "up" });
    await runMigrations({ databaseUrl: second.connectionString, direction: "up" });

    expect(await snapshotDatabase(await connect(first.connectionString))).toEqual(
      await snapshotDatabase(await connect(second.connectionString))
    );
  }, TEST_TIMEOUT_MS);
});

describe("V2 migration: representative V1 snapshot (B-J, T)", () => {
  it("B/C/E: preserves ids and issued numbers; maps legacy states without accepted/paid", async () => {
    const { client } = await migratedV1Database();
    const quotes = await rows<{ quote_id: string; status: string; quote_number: string | null; version: number }>(
      client,
      `select quote_id, status, quote_number, version from quote_service.quotes order by quote_id`
    );

    expect(quotes).toEqual([
      { quote_id: V1_IDS.draft, status: "draft", quote_number: null, version: 2 },
      { quote_id: V1_IDS.issued, status: "issued", quote_number: "PC-000002", version: 2 },
      { quote_id: V1_IDS.accepted, status: "issued", quote_number: "PC-000003", version: 3 },
      { quote_id: V1_IDS.paid, status: "issued", quote_number: "PC-000004", version: 4 },
      { quote_id: V1_IDS.cancelledIssued, status: "cancelled", quote_number: "PC-000005", version: 3 },
      { quote_id: V1_IDS.cancelledDraft, status: "cancelled", quote_number: null, version: 2 },
      { quote_id: V1_IDS.expired, status: "expired", quote_number: "PC-000007", version: 3 },
      { quote_id: V1_IDS.revision, status: "draft", quote_number: null, version: 1 }
    ]);

    // Draft numbers are not reused: kept as legacy evidence; the sequence continues.
    const legacyNumbers = await rows<{ quote_id: string; number: string | null }>(
      client,
      `select quote_id, data -> 'legacy' ->> 'v1QuoteNumber' as number from quote_service.quote_legacy_v1 order by quote_id`
    );
    expect(legacyNumbers.filter((row) => row.number !== null)).toEqual([
      { quote_id: V1_IDS.draft, number: "PC-000001" },
      { quote_id: V1_IDS.cancelledDraft, number: "PC-000006" },
      { quote_id: V1_IDS.revision, number: "PC-000008" }
    ]);
    expect(await rows(client, `select last_value::int as v from quote_service.quote_number_seq`)).toEqual([{ v: 8 }]);

    // E: accepted/paid preserved as legacy evidence, never as V2 lifecycle truth.
    const legacyEvents = await rows<{ quote_id: string; action: string; derived: string | null }>(
      client,
      `select quote_id, data ->> 'action' as action, data ->> 'derivedFrom' as derived
       from quote_service.quote_audit_events
       where quote_id in ($1, $2) and data ->> 'action' in ('accepted', 'paid') order by quote_id, sequence`,
      [V1_IDS.accepted, V1_IDS.paid]
    );
    expect(legacyEvents).toEqual([
      { quote_id: V1_IDS.accepted, action: "accepted", derived: null },
      { quote_id: V1_IDS.paid, action: "accepted", derived: "quotes.accepted_at" },
      { quote_id: V1_IDS.paid, action: "paid", derived: null }
    ]);
    const paidLegacy = await rows<{ legacy: Record<string, unknown> }>(
      client,
      `select data -> 'legacy' as legacy from quote_service.quote_legacy_v1 where quote_id = $1`,
      [V1_IDS.paid]
    );
    expect(paidLegacy[0]!.legacy).toMatchObject({
      v1Status: "paid",
      acceptedAt: "2026-03-11T11:00:00+00:00",
      paidAt: "2026-03-12T09:00:00+00:00"
    });
    await expect(
      client.query(`update quote_service.quotes set status = 'paid' where quote_id = $1`, [V1_IDS.paid])
    ).rejects.toThrow(/invalid quote status transition issued -> paid/);
    await expect(
      client.query(
        `insert into quote_service.quotes (quote_id, status, version, currency, source_system, customer,
           net_amount, tax_amount, gross_amount, exempt_net_amount, created_by_principal_id, created_at, updated_at)
         values (gen_random_uuid(), 'accepted', 1, 'CLP', 'x', '{"kind":"guest"}', 0, 0, 0, 0, 'x', now(), now())`
      )
    ).rejects.toThrow(/quotes_status_check/);

    // Cancellation of migrated quotes.
    expect(
      await rows(
        client,
        `select quote_id, cancellation_reason_code, cancellation_initiated_by, cancelled_at is not null as has_at
         from quote_service.quotes where status = 'cancelled' order by quote_id`
      )
    ).toEqual([
      { quote_id: V1_IDS.cancelledIssued, cancellation_reason_code: "legacy_v1", cancellation_initiated_by: "legacy-v1", has_at: true },
      { quote_id: V1_IDS.cancelledDraft, cancellation_reason_code: "legacy_v1", cancellation_initiated_by: "legacy-v1", has_at: true }
    ]);

    // Revision linkage is legacy evidence only (no V2 revisions).
    const revision = await rows<{ revision: unknown }>(
      client,
      `select data -> 'legacy' -> 'revision' as revision from quote_service.quote_legacy_v1 where quote_id = $1`,
      [V1_IDS.revision]
    );
    expect(revision[0]!.revision).toEqual({
      revisionRootId: V1_IDS.issued,
      previousRevisionId: V1_IDS.issued,
      supersedesQuoteId: V1_IDS.issued
    });
  }, TEST_TIMEOUT_MS);

  it("D: preserves issued document hashes and storage references with a synthetic succeeded operation", async () => {
    const { client } = await migratedV1Database();
    const documents = await rows<{
      quote_id: string; pdf_sha256: string; storage_key: string; artifact_ref: string; origin: string;
      template_version: string; renderer_version: string; semantic_hash_algorithm: string; byte_length: number | null;
    }>(
      client,
      `select quote_id, pdf_sha256, storage_key, artifact_ref, origin, template_version, renderer_version,
              semantic_hash_algorithm, byte_length
       from quote_service.quote_documents order by quote_id`
    );

    expect(documents.map((document) => document.quote_id)).toEqual([
      V1_IDS.issued, V1_IDS.accepted, V1_IDS.paid, V1_IDS.cancelledIssued, V1_IDS.expired
    ]);

    for (const document of documents) {
      const expectedSha = crypto.createHash("sha256").update(V1_PDF_BYTES[document.quote_id]!).digest("hex");
      expect(document).toMatchObject({
        pdf_sha256: expectedSha,
        artifact_ref: `sha256:${expectedSha}`,
        origin: "legacy_v1",
        template_version: "v1-legacy",
        renderer_version: "quote-pdf-v3",
        semantic_hash_algorithm: "v1-canonical-json",
        byte_length: null
      });
      expect(document.storage_key).toMatch(new RegExp(`^quotes/${document.quote_id}/[0-9a-f]{64}/quote\\.pdf$`));
    }

    const operations = await rows(
      client,
      `select o.quote_id, o.status, o.origin, o.attempt_count, o.generation, q.current_operation_id = o.operation_id as current
       from quote_service.issuance_operations o join quote_service.quotes q using (quote_id) order by o.quote_id`
    );
    expect(operations).toEqual(
      documents.map((document) => ({
        quote_id: document.quote_id, status: "succeeded", origin: "legacy_v1_migration",
        attempt_count: 0, generation: "0", current: true
      }))
    );

    // HTML artifacts are legacy evidence only.
    const html = await rows<{ html: { sha256: string } | null }>(
      client,
      `select data -> 'legacy' -> 'html' as html from quote_service.quote_legacy_v1 where quote_id = $1`,
      [V1_IDS.issued]
    );
    expect(html[0]!.html?.sha256).toBe(sha256Hex("html:PC-000002"));
  }, TEST_TIMEOUT_MS);

  it("F: maps opportunityId to generic external correlation without discarding it", async () => {
    const { client } = await migratedV1Database();

    expect(
      await rows(
        client,
        `select quote_id, source_system, external_reference_type, external_reference
         from quote_service.quotes where quote_id in ($1, $2) order by quote_id`,
        [V1_IDS.issued, V1_IDS.paid]
      )
    ).toEqual([
      { quote_id: V1_IDS.issued, source_system: "crm_customer_360", external_reference_type: "opportunity", external_reference: "opp-crm-002" },
      { quote_id: V1_IDS.paid, source_system: "legacy-v1", external_reference_type: "opportunity", external_reference: "opp-manual-004" }
    ]);

    // Several quotes may share one external reference (no uniqueness).
    expect(
      await rows(
        client,
        `select count(*)::int as n from quote_service.quotes where external_reference = 'opp-crm-002'`
      )
    ).toEqual([{ n: 2 }]);

    // No opportunity column remains; request/trace correlation is legacy only.
    expect(
      await rows(
        client,
        `select column_name from information_schema.columns
         where table_schema = 'quote_service' and table_name = 'quotes' and column_name ~ 'opportunity|correlation'`
      )
    ).toEqual([]);
    const legacy = await rows<{ legacy: Record<string, unknown> }>(
      client,
      `select data -> 'legacy' as legacy from quote_service.quote_legacy_v1 where quote_id = $1`,
      [V1_IDS.issued]
    );
    expect(legacy[0]!.legacy).toMatchObject({
      opportunityId: "opp-crm-002",
      sourceCorrelationId: "corr-PC-000002",
      conversationId: "conv-PC-000002"
    });
  }, TEST_TIMEOUT_MS);

  it("customer snapshots become guest/person/company without fabricating values", async () => {
    const { client } = await migratedV1Database();
    const customers = Object.fromEntries(
      (await rows<{ quote_id: string; customer: unknown }>(client, `select quote_id, customer from quote_service.quotes`)).map(
        (row) => [row.quote_id, row.customer]
      )
    );

    expect(customers[V1_IDS.issued]).toEqual({
      kind: "company",
      legalName: "Gimnasio Andes SpA",
      contactName: "Pedro Soto",
      email: "compras@andes.example.com",
      phone: "+56 2 2345 6789",
      address: { lines: ["Av. Providencia 1234"], commune: "Providencia", region: "Región Metropolitana", country: "CL" },
      externalCustomerReference: { sourceSystem: "crm_customer_360", reference: "cust-002" }
    });
    // Invalid email/phone are moved to legacy evidence, not kept on the snapshot.
    expect(customers[V1_IDS.accepted]).toEqual({ kind: "person", displayName: "Ana Díaz" });
    expect(customers[V1_IDS.paid]).toEqual({ kind: "person", displayName: "Luis Pérez", address: { commune: "Ñuñoa", country: "CL" } });
    const invalid = await rows<{ invalid: unknown }>(
      client,
      `select data -> 'legacy' -> 'invalidCustomerFields' as invalid from quote_service.quote_legacy_v1 where quote_id = $1`,
      [V1_IDS.accepted]
    );
    expect(invalid[0]!.invalid).toEqual({ email: "not-an-email", phone: "12" });
  }, TEST_TIMEOUT_MS);

  it("G: V1 shipping lines become legacy service lines; nothing is fabricated into the shipping snapshot", async () => {
    const { client } = await migratedV1Database();
    const lines = await rows(
      client,
      `select position, kind, item_source_system, item_description, quantity::text, quantity_unit, unit_amount::int,
              tax_basis, tax_rate::text, net_amount::int, tax_amount::int, gross_amount::int
       from quote_service.quote_lines where quote_id = $1 order by position`,
      [V1_IDS.issued]
    );

    expect(lines).toEqual([
      { position: 1, kind: "product", item_source_system: "pesaschile-catalog", item_description: "Mancuerna hexagonal 10 kg", quantity: "2.000000", quantity_unit: "unit", unit_amount: 24990, tax_basis: "included", tax_rate: "0.190000", net_amount: 42000, tax_amount: 7980, gross_amount: 49980 },
      { position: 2, kind: "service", item_source_system: "legacy-v1-shipping", item_description: "Despacho Starken a Ñuñoa", quantity: "1.000000", quantity_unit: "unit", unit_amount: 5990, tax_basis: "excluded", tax_rate: "0.190000", net_amount: 5990, tax_amount: 1138, gross_amount: 7128 },
      { position: 3, kind: "product", item_source_system: "legacy-v1", item_description: "Piso de goma 15 mm (m2)", quantity: "12.500000", quantity_unit: "unit", unit_amount: 18990, tax_basis: "included", tax_rate: "0.190000", net_amount: 199475, tax_amount: 37900, gross_amount: 237375 }
    ]);
    expect(await rows(client, `select count(*)::int as n from quote_service.quote_shipping`)).toEqual([{ n: 0 }]);

    const exempt = await rows(
      client,
      `select tax_basis, tax_rate, tax_amount::int from quote_service.quote_lines where quote_id = $1 and position = 1`,
      [V1_IDS.paid]
    );
    expect(exempt).toEqual([{ tax_basis: "exempt", tax_rate: null, tax_amount: 0 }]);

    const totals = await rows(
      client,
      `select net_amount::int, tax_amount::int, gross_amount::int, exempt_net_amount::int from quote_service.quotes where quote_id = $1`,
      [V1_IDS.paid]
    );
    expect(totals).toEqual([{ net_amount: 40990, tax_amount: 1138, gross_amount: 42128, exempt_net_amount: 35000 }]);
  }, TEST_TIMEOUT_MS);

  it("H: legacy validUntil is preserved as caller-supplied evidence, never recomputed", async () => {
    const { client } = await migratedV1Database();
    const validity = await rows(
      client,
      `select quote_id, validity_source, validity_policy_id, validity_tzdb_version, validity_issuer_zone,
              validity_issue_local_date::text as issue_date, validity_through_local_date::text as through_date,
              valid_until_exclusive = '2026-03-15T03:00:00Z'::timestamptz as exclusive_preserved,
              expired_at::text as expired_at
       from quote_service.quotes where quote_id in ($1, $2, $3) order by quote_id`,
      [V1_IDS.draft, V1_IDS.issued, V1_IDS.expired]
    );

    expect(validity).toEqual([
      { quote_id: V1_IDS.draft, validity_source: null, validity_policy_id: null, validity_tzdb_version: null, validity_issuer_zone: null, issue_date: null, through_date: null, exclusive_preserved: null, expired_at: null },
      // Issued 2026-03-10 11:00 Chile; valid until 2026-03-15 00:00 Chile (exclusive) -> through 2026-03-14.
      { quote_id: V1_IDS.issued, validity_source: "legacy_caller_supplied", validity_policy_id: null, validity_tzdb_version: null, validity_issuer_zone: "America/Santiago", issue_date: "2026-03-10", through_date: "2026-03-14", exclusive_preserved: true, expired_at: null },
      // The recorded V1 expiry instant is kept as recorded (not snapped to validUntilExclusive).
      { quote_id: V1_IDS.expired, validity_source: "legacy_caller_supplied", validity_policy_id: null, validity_tzdb_version: null, validity_issuer_zone: "America/Santiago", issue_date: "2026-03-10", through_date: "2026-03-14", exclusive_preserved: true, expired_at: "2026-03-15 03:00:05+00" }
    ]);
  }, TEST_TIMEOUT_MS);

  it("I: pending V1 email becomes an explicit migration outcome and can never be sent", async () => {
    const { client } = await migratedV1Database();

    expect(
      await rows(
        client,
        `select delivery_id, status, last_error_code, sent_at is not null as sent, next_attempt_at, recipient_masked, origin
         from quote_service.quote_deliveries order by delivery_id`
      )
    ).toEqual([
      { delivery_id: V1_DELIVERIES.sent, status: "sent", last_error_code: null, sent: true, next_attempt_at: null, recipient_masked: "co***@andes.example.com", origin: "legacy_v1" },
      { delivery_id: V1_DELIVERIES.pending, status: "failed", last_error_code: "superseded_by_v2_migration", sent: false, next_attempt_at: null, recipient_masked: "co***@andes.example.com", origin: "legacy_v1" },
      { delivery_id: V1_DELIVERIES.processing, status: "unknown", last_error_code: null, sent: false, next_attempt_at: null, recipient_masked: "so***@example.com", origin: "legacy_v1" },
      { delivery_id: V1_DELIVERIES.failed, status: "failed", last_error_code: "legacy_v1_delivery_failed", sent: false, next_attempt_at: null, recipient_masked: "so***@example.com", origin: "legacy_v1" }
    ]);
    // A pending delivery cannot exist without a schedule, and none is pending.
    expect(
      await rows(client, `select count(*)::int as n from quote_service.quote_deliveries where status in ('pending', 'sending')`)
    ).toEqual([{ n: 0 }]);
  }, TEST_TIMEOUT_MS);

  it("J: completed V1 idempotency rows become typed legacy bindings; raw keys never survive", async () => {
    const { client } = await migratedV1Database();

    expect(
      await rows(
        client,
        `select principal_id, operation, key_hash, binding_kind, fingerprint_algorithm, resource_type, quote_id, delivery_id, request_snapshot
         from quote_service.idempotency_bindings order by operation`
      )
    ).toEqual([
      { principal_id: "legacy-v1", operation: "legacy.v1.create_draft_quote", key_hash: sha256Hex(V1_RAW_IDEMPOTENCY_KEYS.createDraft), binding_kind: "legacy_v1", fingerprint_algorithm: "v1-request-hash", resource_type: "quote", quote_id: V1_IDS.draft, delivery_id: null, request_snapshot: null },
      { principal_id: "legacy-v1", operation: "legacy.v1.issue_quote", key_hash: sha256Hex(V1_RAW_IDEMPOTENCY_KEYS.issue), binding_kind: "legacy_v1", fingerprint_algorithm: "v1-request-hash", resource_type: "quote", quote_id: V1_IDS.issued, delivery_id: null, request_snapshot: null },
      { principal_id: "legacy-v1", operation: "legacy.v1.send_quote_email", key_hash: sha256Hex(V1_RAW_IDEMPOTENCY_KEYS.sendEmail), binding_kind: "legacy_v1", fingerprint_algorithm: "v1-request-hash", resource_type: "delivery", quote_id: V1_IDS.issued, delivery_id: V1_DELIVERIES.sent, request_snapshot: null }
    ]);

    // No raw key, and no V1 response snapshot, anywhere in the database.
    const everything = JSON.stringify(await snapshotDatabase(client));
    for (const rawKey of Object.values(V1_RAW_IDEMPOTENCY_KEYS)) {
      expect(everything).not.toContain(rawKey);
    }
    expect(everything).not.toContain("V1 response with PII");

    // The audit key hash of a V1 event is the SHA-256 of the raw key.
    expect(
      await rows(
        client,
        `select idempotency_key_hash from quote_service.quote_audit_events where idempotency_key_hash is not null order by idempotency_key_hash`
      )
    ).toEqual(
      [V1_RAW_IDEMPOTENCY_KEYS.createDraft, V1_RAW_IDEMPOTENCY_KEYS.issue]
        .map((key) => ({ idempotency_key_hash: sha256Hex(key) }))
        .sort((a, b) => a.idempotency_key_hash.localeCompare(b.idempotency_key_hash))
    );
  }, TEST_TIMEOUT_MS);

  it("audit history is preserved in order without customer PII in V2 audit data", async () => {
    const { client } = await migratedV1Database();
    const events = await rows<{ sequence: number; type: string; principal: string; action: string; correlation: string | null }>(
      client,
      `select sequence, event_type as type, principal_id as principal, data ->> 'action' as action, correlation_id as correlation
       from quote_service.quote_audit_events where quote_id = $1 order by sequence`,
      [V1_IDS.issued]
    );

    expect(events).toEqual([
      { sequence: 1, type: "legacy.v1.event", principal: "legacy-v1", action: "draft_created", correlation: "corr-PC-000002" },
      { sequence: 2, type: "legacy.v1.event", principal: "legacy-v1", action: "issued", correlation: "corr-PC-000002" }
    ]);
    const auditText = JSON.stringify(await rows(client, `select data from quote_service.quote_audit_events`));
    expect(auditText).not.toContain("Pedro Soto");
    expect(auditText).not.toContain("V1 payload snapshot with PII");
  }, TEST_TIMEOUT_MS);

  it("Q: a migrated V1 database is at the expected head for readiness, with backfilled V1 checksums", async () => {
    const { handle, client } = await migratedV1Database();

    expect((await probeSchema(handle.connectionString)).schema.state).toBe("READY");
    expect(
      await rows(client, `select name, provenance from quote_service.schema_migration_checksums order by name`)
    ).toEqual(
      MIGRATION_MANIFEST.map((entry, index) => ({ name: entry.name, provenance: index < 5 ? "backfilled" : "applied" }))
    );
  }, TEST_TIMEOUT_MS);

  it("T: migration from a representative V1 snapshot is deterministic", async () => {
    const first = await migratedV1Database();
    const second = await migratedV1Database();

    expect(await snapshotDatabase(first.client)).toEqual(await snapshotDatabase(second.client));
  }, TEST_TIMEOUT_MS);
});

describe("V2 migration: legacy artifacts (D, item 14)", () => {
  it("verifies preserved V1 artifacts byte-for-byte and reports missing/altered files without regenerating them", async () => {
    const { client } = await migratedV1Database();
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-legacy-artifacts-"));
    cleanups.push(() => fsPromises.rm(root, { recursive: true, force: true }));
    const documents = await rows<{ quote_id: string; storage_key: string }>(
      client,
      `select quote_id, storage_key from quote_service.quote_documents order by quote_id`
    );

    for (const document of documents) {
      if (document.quote_id === V1_IDS.cancelledIssued) {
        continue; // missing artifact
      }

      const target = path.join(root, document.storage_key);
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(
        target,
        document.quote_id === V1_IDS.expired ? Buffer.from("tampered bytes") : V1_PDF_BYTES[document.quote_id]!
      );
    }

    // R1.5B4: the same verified read as the document endpoint (legacy keys and null byteLength honoured).
    const store = new FilesystemContentAddressedArtifactStore(root);
    const before = await snapshotDatabase(client);
    const readOnly = await verifyDocumentArtifacts({ database: client, store, recordLegacyByteLength: false });

    expect(readOnly).toMatchObject({ checked: 5, ok: 3, byteLengthsRecorded: 0 });
    expect(readOnly.problems.map((problem) => [problem.quoteId, problem.status])).toEqual([
      [V1_IDS.cancelledIssued, "MISSING"],
      [V1_IDS.expired, "HASH_MISMATCH"]
    ]);
    expect(await snapshotDatabase(client)).toEqual(before);
    // Nothing was written or regenerated in storage.
    await expect(fsPromises.access(path.join(root, documents.find((d) => d.quote_id === V1_IDS.cancelledIssued)!.storage_key))).rejects.toThrow();

    const recorded = await verifyDocumentArtifacts({ database: client, store, recordLegacyByteLength: true });
    expect(recorded.byteLengthsRecorded).toBe(3);
    expect(
      await rows(client, `select quote_id, byte_length::int from quote_service.quote_documents where byte_length is not null order by quote_id`)
    ).toEqual(
      [V1_IDS.issued, V1_IDS.accepted, V1_IDS.paid].map((quoteId) => ({ quote_id: quoteId, byte_length: V1_PDF_BYTES[quoteId]!.byteLength }))
    );
    // Once recorded, the size is immutable like the rest of the manifest.
    await expect(
      client.query(`update quote_service.quote_documents set byte_length = 1 where quote_id = $1`, [V1_IDS.issued])
    ).rejects.toThrow(/immutable/);
  }, TEST_TIMEOUT_MS);
});

describe("V2 migration: exceptions", () => {
  it("aborts with a PII-free exception report and leaves the V1 database untouched", async () => {
    const handle = await database();
    await migrateToV1Head(handle.connectionString);
    await seedV1Snapshot(handle.connectionString, {
      overrideDescription: { quoteId: V1_IDS.issued, description: "x".repeat(301) }
    });

    const failure = await runMigrations({ databaseUrl: handle.connectionString, direction: "up" }).catch(
      (error: unknown) => error as Error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("V1 -> V2 migration exceptions: 1 row(s)");
    expect((failure as Error).message).toContain(`${V1_IDS.issued} line_description_invalid`);
    expect((failure as Error).message).not.toContain("xxxxxxxxxx");

    // Nothing changed: still a V1 database, readiness reports the schema behind.
    const client = await connect(handle.connectionString);
    expect(await rows(client, `select count(*)::int as n from quote_service.quotes`)).toEqual([{ n: 8 }]);
    expect(await rows(client, `select to_regclass('quote_service.quote_email_outbox') is not null as v1`)).toEqual([{ v1: true }]);
    expect((await probeSchema(handle.connectionString)).schema).toEqual({
      state: "SCHEMA_BEHIND",
      actualHead: "000005_quote_line_shipping"
    });
  }, TEST_TIMEOUT_MS);
});

describe("V2 persistence constraints (K, L, M) and immutability", () => {
  async function freshClient(): Promise<pg.Client> {
    const handle = await database();
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    return connect(handle.connectionString);
  }

  const DRAFT = `insert into quote_service.quotes (
      quote_id, status, version, quote_number, currency, source_system, customer,
      net_amount, tax_amount, gross_amount, exempt_net_amount, created_by_principal_id, created_at, updated_at
    ) values ($1, 'draft', 1, $2, 'CLP', 'sales-integration', '{"kind":"guest"}', 0, 0, 0, 0, 'sales-integration', now(), now())`;

  async function acceptForIssue(client: pg.Client, quoteId: string, quoteNumber: string, operationId: string) {
    await client.query("begin");
    await client.query(
      `insert into quote_service.issuance_operations (
         operation_id, quote_id, operation_type, origin, status, accepted_at, deadline_at, next_attempt_at,
         snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
       ) values ($1, $2, 'quote.issue', 'acceptance', 'pending', now(), now() + interval '24 hours', now(),
                 $3, 'jcs-sha256-v2', now(), now())`,
      [operationId, quoteId, "a".repeat(64)]
    );
    await client.query(
      `update quote_service.quotes set status = 'issuing', version = version + 1, quote_number = $2,
         issued_at = now(), issuer_profile_id = 'pesaschile-cl-v1', current_operation_id = $3,
         validity_source = 'policy', validity_policy_id = 'cl-retail-5-calendar-days-v1',
         validity_issuer_zone = 'America/Santiago', validity_tzdb_version = '2025a',
         validity_issue_local_date = current_date, validity_through_local_date = current_date + 4,
         valid_until_exclusive = now() + interval '5 days'
       where quote_id = $1`,
      [quoteId, quoteNumber, operationId]
    );
    await client.query("commit");
  }

  it("M: quote number is nullable for drafts, unique when present, never set on a draft", async () => {
    const client = await freshClient();
    await client.query(DRAFT, [crypto.randomUUID(), null]);
    await client.query(DRAFT, [crypto.randomUUID(), null]);

    await expect(client.query(DRAFT, [crypto.randomUUID(), "PC-000009"])).rejects.toThrow(/quotes_status_requires_acceptance|quotes_issue_acceptance_atomic/);

    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await client.query(DRAFT, [first, null]);
    await client.query(DRAFT, [second, null]);
    await acceptForIssue(client, first, "PC-1000000", crypto.randomUUID());
    await expect(acceptForIssue(client, second, "PC-1000000", crypto.randomUUID())).rejects.toThrow(/quotes_quote_number_unique/);
    await client.query("rollback").catch(() => undefined);

    // Numbers past 999999 are not truncated.
    expect(await rows(client, `select quote_number from quote_service.quotes where quote_id = $1`, [first])).toEqual([
      { quote_number: "PC-1000000" }
    ]);
  }, TEST_TIMEOUT_MS);

  it("L: issuance-operation constraints reject impossible states", async () => {
    const client = await freshClient();
    const quoteId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await client.query(DRAFT, [quoteId, null]);
    await acceptForIssue(client, quoteId, "PC-000010", operationId);

    const insertOperation = (status: string, extra = "") =>
      client.query(
        `insert into quote_service.issuance_operations (
           operation_id, quote_id, operation_type, origin, status, accepted_at, deadline_at, next_attempt_at,
           snapshot_hash, snapshot_hash_algorithm, created_at, updated_at ${extra ? ", " + extra.split("=")[0] : ""}
         ) values ($1, $2, 'quote.issue', 'acceptance', $3, now(), now() + interval '1 day', now(), $4, 'jcs-sha256-v2', now(), now()
           ${extra ? ", " + extra.split("=")[1] : ""})`,
        [crypto.randomUUID(), quoteId, status, "b".repeat(64)]
      );

    // At most one active operation per quote.
    await expect(insertOperation("pending")).rejects.toThrow(/issuance_operations_one_active_per_quote/);
    // running requires a lease; failed requires an error code; terminal requires completed_at.
    await expect(
      client.query(`update quote_service.issuance_operations set status = 'running', attempt_count = 1, generation = 1 where operation_id = $1`, [operationId])
    ).rejects.toThrow(/issuance_operations_lease_iff_running/);
    await expect(
      client.query(`update quote_service.issuance_operations set status = 'failed', completed_at = now() where operation_id = $1`, [operationId])
    ).rejects.toThrow(/issuance_operations_failed_has_code/);
    await expect(
      client.query(`update quote_service.issuance_operations set status = 'succeeded' where operation_id = $1`, [operationId])
    ).rejects.toThrow(/issuance_operations_terminal_iff_completed|issuance_operations_attempted/);
    // Deadline must follow acceptance.
    await expect(
      client.query(`update quote_service.issuance_operations set deadline_at = accepted_at where operation_id = $1`, [operationId])
    ).rejects.toThrow(/immutable|issuance_operations_deadline_after_acceptance/);

    // A valid claim, then the fencing generation can never decrease.
    await client.query(
      `update quote_service.issuance_operations
       set status = 'running', generation = 1, attempt_count = 1, lease_owner = 'worker-a',
           lease_expires_at = now() + interval '1 minute', last_attempt_at = now()
       where operation_id = $1`,
      [operationId]
    );
    await expect(
      client.query(`update quote_service.issuance_operations set generation = 0 where operation_id = $1`, [operationId])
    ).rejects.toThrow(/never decrease/);

    // Deadline sweep: operation failed, quote stays issuing (amendment A1).
    await client.query(
      `update quote_service.issuance_operations
       set status = 'failed', generation = generation + 1, lease_owner = null, lease_expires_at = null,
           last_error_code = 'issuance_deadline_exceeded', completed_at = now()
       where operation_id = $1`,
      [operationId]
    );
    expect(await rows(client, `select status from quote_service.quotes where quote_id = $1`, [quoteId])).toEqual([{ status: "issuing" }]);
    // Terminal operations are immutable.
    await expect(
      client.query(`update quote_service.issuance_operations set last_error_code = 'document_storage_failed' where operation_id = $1`, [operationId])
    ).rejects.toThrow(/terminal/);

    // Operator retry: a new operation for the same quote, linked to the failed one.
    const retryId = crypto.randomUUID();
    await client.query(
      `insert into quote_service.issuance_operations (
         operation_id, quote_id, operation_type, origin, retry_of_operation_id, status, accepted_at, deadline_at,
         next_attempt_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
       ) values ($1, $2, 'quote.issue', 'operator_retry', $3, 'pending', now(), now() + interval '1 day', now(), $4, 'jcs-sha256-v2', now(), now())`,
      [retryId, quoteId, operationId, "a".repeat(64)]
    );
    await expect(
      client.query(
        `insert into quote_service.issuance_operations (
           operation_id, quote_id, operation_type, origin, status, accepted_at, deadline_at,
           next_attempt_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
         ) values ($1, $2, 'quote.issue', 'operator_retry', 'pending', now(), now() + interval '1 day', now(), $3, 'jcs-sha256-v2', now(), now())`,
        [crypto.randomUUID(), crypto.randomUUID(), "a".repeat(64)]
      )
    ).rejects.toThrow(/issuance_operations_retry_lineage|foreign key/);

    // issuing -> issued requires a committed manifest (checked at commit).
    await client.query(`update quote_service.quotes set current_operation_id = $2, version = version + 1 where quote_id = $1`, [quoteId, retryId]);
    await client.query("begin");
    await client.query(`update quote_service.quotes set status = 'issued', version = version + 1 where quote_id = $1`, [quoteId]);
    await expect(client.query("commit")).rejects.toThrow(/without a committed document manifest/);
  }, TEST_TIMEOUT_MS);

  it("K: V2 idempotency bindings are unique per (principal, operation, key hash)", async () => {
    const client = await freshClient();
    const quoteId = crypto.randomUUID();
    await client.query(DRAFT, [quoteId, null]);
    const keyHash = sha256Hex("caller-key-1");
    const bind = (principal: string, operation: string, snapshot: string | null = '{"body":1}') =>
      client.query(
        `insert into quote_service.idempotency_bindings (
           principal_id, operation, key_hash, binding_kind, request_fingerprint, fingerprint_algorithm,
           request_snapshot, resource_type, quote_id, bound_at
         ) values ($1, $2, $3, 'v2', $4, 'jcs-sha256-v2', $5, 'quote', $6, now())`,
        [principal, operation, keyHash, sha256Hex("fingerprint"), snapshot, quoteId]
      );

    await bind("sales-integration", "quote.draft.create");
    await expect(bind("sales-integration", "quote.draft.create")).rejects.toThrow(/idempotency_bindings_pkey/);
    // Cross-principal and cross-operation scopes are independent.
    await bind("backoffice", "quote.draft.create");
    await bind("sales-integration", "quote.cancel");
    // Shape rules: V2 needs a request snapshot, an operation id for issuance
    // operations, a contract operation name, and never the legacy principal.
    await expect(bind("sales-integration", "quote.draft.update", null)).rejects.toThrow(/idempotency_bindings_v2_shape/);
    await expect(bind("sales-integration", "quote.issue")).rejects.toThrow(/idempotency_bindings_v2_shape/);
    await expect(bind("sales-integration", "quote.accept")).rejects.toThrow(/idempotency_bindings_v2_shape/);
    await expect(bind("legacy-v1", "quote.draft.update")).rejects.toThrow(/idempotency_bindings_v2_shape/);
    // Bindings are immutable.
    await expect(client.query(`update quote_service.idempotency_bindings set bound_at = now()`)).rejects.toThrow(/not allowed/);
    await expect(client.query(`delete from quote_service.idempotency_bindings`)).rejects.toThrow(/not allowed/);
  }, TEST_TIMEOUT_MS);

  it("issued snapshots, manifests, audit and legacy evidence are immutable", async () => {
    const { client } = await migratedV1Database();

    await expect(
      client.query(`update quote_service.quotes set customer = '{"kind":"guest"}' where quote_id = $1`, [V1_IDS.issued])
    ).rejects.toThrow(/issued quote snapshot is immutable/);
    await expect(
      client.query(`update quote_service.quotes set status = 'draft' where quote_id = $1`, [V1_IDS.issued])
    ).rejects.toThrow(/invalid quote status transition issued -> draft/);
    await expect(
      client.query(`update quote_service.quote_lines set unit_amount = 1 where quote_id = $1`, [V1_IDS.issued])
    ).rejects.toThrow(/quote is issued/);
    await expect(
      client.query(`delete from quote_service.quote_lines where quote_id = $1`, [V1_IDS.issued])
    ).rejects.toThrow(/quote is issued/);
    await expect(
      client.query(`update quote_service.quote_documents set pdf_sha256 = $2 where quote_id = $1`, [V1_IDS.issued, "0".repeat(64)])
    ).rejects.toThrow(/immutable/);
    await expect(client.query(`update quote_service.quote_audit_events set principal_id = 'x'`)).rejects.toThrow(/not allowed/);
    await expect(client.query(`delete from quote_service.quote_legacy_v1`)).rejects.toThrow(/not allowed/);
    await expect(client.query(`delete from quote_service.quotes where quote_id = $1`, [V1_IDS.draft])).rejects.toThrow(/not allowed/);

    // Draft lines stay editable; cancel and expiry of an issued quote are allowed transitions.
    await client.query(`update quote_service.quote_lines set item_description = 'Editado' where quote_id = $1 and position = 1`, [V1_IDS.draft]);
    await client.query(
      `update quote_service.quotes set status = 'cancelled', version = version + 1, cancelled_at = now(),
         cancellation_reason_code = 'customer_declined', cancellation_initiated_by = 'backoffice'
       where quote_id = $1`,
      [V1_IDS.issued]
    );
  }, TEST_TIMEOUT_MS);
});

describe("migration integrity (R)", () => {
  it("detects an applied migration whose recorded checksum differs (same name, changed bytes)", async () => {
    const handle = await database();
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    const client = await connect(handle.connectionString);

    // Simulate a database migrated by a different file with the same name.
    await client.query(`alter table quote_service.schema_migration_checksums disable trigger schema_migration_checksums_append_only`);
    await client.query(`update quote_service.schema_migration_checksums set sha256 = $1 where name = '000003_quote_email_delivery'`, ["f".repeat(64)]);
    await client.query(`alter table quote_service.schema_migration_checksums enable trigger schema_migration_checksums_append_only`);

    expect((await probeSchema(handle.connectionString)).schema.state).toBe("SCHEMA_INTEGRITY_MISMATCH");
    await expect(runMigrations({ databaseUrl: handle.connectionString, direction: "up" })).rejects.toBeInstanceOf(
      MigrationIntegrityError
    );
  }, TEST_TIMEOUT_MS);

  it("reports a missing checksum record as unverified (not ready) until the migrate command backfills it", async () => {
    const handle = await database();
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    const client = await connect(handle.connectionString);

    await client.query(`alter table quote_service.schema_migration_checksums disable trigger schema_migration_checksums_append_only`);
    await client.query(`delete from quote_service.schema_migration_checksums where name = '000007_quote_v2_persistence'`);
    await client.query(`alter table quote_service.schema_migration_checksums enable trigger schema_migration_checksums_append_only`);

    expect((await probeSchema(handle.connectionString)).schema.state).toBe("SCHEMA_INTEGRITY_UNVERIFIED");
    await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
    expect((await probeSchema(handle.connectionString)).schema.state).toBe("READY");
    expect(
      await rows(client, `select provenance from quote_service.schema_migration_checksums where name = '000007_quote_v2_persistence'`)
    ).toEqual([{ provenance: "backfilled" }]);
  }, TEST_TIMEOUT_MS);
});
