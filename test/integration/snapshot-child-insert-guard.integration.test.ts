import crypto from "node:crypto";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { createTestDatabase } from "../helpers/test-database";
import { migrateToV1Head, seedV1Snapshot } from "../helpers/v1-fixture";

/*
 * R1.4 persistence erratum (found in R1.5A.3), migration 000009:
 * quote_lines / quote_shipping INSERT is allowed only while the parent quote
 * is a draft. 000007 already guards UPDATE/DELETE; this covers INSERT.
 */

const TEST_TIMEOUT_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  cleanups.push(() => client.end());
  return client;
}

/** V2 database migrated from the V1 fixture: real draft, issued, expired and cancelled quotes. */
async function migratedDatabase(): Promise<string> {
  const handle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => handle.dispose());
  await migrateToV1Head(handle.connectionString);
  await seedV1Snapshot(handle.connectionString);
  await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
  return handle.connectionString;
}

const insertLine = (client: pg.Client, quoteId: string, position = 100) =>
  client.query(
    `insert into quote_service.quote_lines (
       line_id, quote_id, position, kind, item_source_system, item_description, quantity, quantity_unit,
       unit_amount, tax_basis, net_amount, tax_amount, gross_amount
     ) values ($1, $2, $3, 'service', 'backoffice', 'Guard probe', 1, 'unit', 1000, 'exempt', 1000, 0, 1000)`,
    [crypto.randomUUID(), quoteId, position]
  );

const insertShipping = (client: pg.Client, quoteId: string) =>
  client.query(
    `insert into quote_service.quote_shipping (
       quote_id, carrier_name, destination_commune, destination_country, amount, tax_basis, net_amount, tax_amount, gross_amount
     ) values ($1, 'Starken', 'Ñuñoa', 'CL', 5990, 'exempt', 5990, 0, 5990)`,
    [quoteId]
  );

async function newDraft(client: pg.Client): Promise<string> {
  const quoteId = crypto.randomUUID();
  await client.query(
    `insert into quote_service.quotes (
       quote_id, status, version, currency, source_system, customer, net_amount, tax_amount, gross_amount,
       exempt_net_amount, created_by_principal_id, created_at, updated_at
     ) values ($1, 'draft', 1, 'CLP', 'backoffice', '{"kind":"guest"}', 0, 0, 0, 0, 'backoffice', now(), now())`,
    [quoteId]
  );
  return quoteId;
}

/** draft → issuing with a pending operation (statements only; the caller owns the transaction). */
async function acceptForIssue(client: pg.Client, quoteId: string): Promise<void> {
  const operationId = crypto.randomUUID();
  await client.query(
    `insert into quote_service.issuance_operations (
       operation_id, quote_id, operation_type, origin, status, accepted_at, deadline_at, next_attempt_at,
       snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
     ) values ($1, $2, 'quote.issue', 'acceptance', 'pending', now(), now() + interval '24 hours', now(),
               $3, 'jcs-sha256-v2', now(), now())`,
    [operationId, quoteId, "a".repeat(64)]
  );
  await client.query(
    `update quote_service.quotes set status = 'issuing', version = version + 1,
       quote_number = 'PC-' || lpad(nextval('quote_service.quote_number_seq')::text, 6, '0'),
       issued_at = now(), issuer_profile_id = 'pesaschile-cl-v1', current_operation_id = $2,
       validity_source = 'policy', validity_policy_id = 'cl-retail-5-calendar-days-v1',
       validity_issuer_zone = 'America/Santiago', validity_tzdb_version = '2025a',
       validity_issue_local_date = current_date, validity_through_local_date = current_date + 4,
       valid_until_exclusive = now() + interval '5 days'
     where quote_id = $1`,
    [quoteId, operationId]
  );
}

describe("000009 snapshot child INSERT guard (R1.4 erratum)", () => {
  it("allows line and shipping inserts on a draft and rejects them for issuing, issued, expired and cancelled", async () => {
    const url = await migratedDatabase();
    const client = await connect(url);

    const draft = await newDraft(client);
    await insertLine(client, draft, 1);
    await insertShipping(client, draft);

    const issuing = await newDraft(client);
    await client.query("begin");
    await acceptForIssue(client, issuing);
    await client.query("commit");

    const byStatus = new Map<string, string>([["issuing", issuing]]);
    for (const row of (await client.query<{ quote_id: string; status: string }>(
      `select quote_id, status from quote_service.quotes order by quote_id`
    )).rows) {
      if (!byStatus.has(row.status)) {
        byStatus.set(row.status, row.quote_id);
      }
    }

    expect([...byStatus.keys()].sort()).toEqual(["cancelled", "draft", "expired", "issued", "issuing"]);

    for (const status of ["issuing", "issued", "expired", "cancelled"]) {
      const quoteId = byStatus.get(status)!;
      const before = (await client.query<{ n: number }>(`select count(*)::int as n from quote_service.quote_lines where quote_id = $1`, [quoteId])).rows[0];

      await expect(insertLine(client, quoteId)).rejects.toMatchObject({
        code: "55000",
        message: `INSERT on quote_service.quote_lines is not allowed: quote is ${status}`
      });
      await expect(insertShipping(client, quoteId)).rejects.toMatchObject({
        code: "55000",
        message: `INSERT on quote_service.quote_shipping is not allowed: quote is ${status}`
      });
      expect((await client.query(`select count(*)::int as n from quote_service.quote_lines where quote_id = $1`, [quoteId])).rows[0]).toEqual(before);
    }

    // The existing 000007 UPDATE/DELETE guards are unchanged; drafts stay fully editable.
    await expect(client.query(`update quote_service.quote_lines set quantity = 2 where quote_id = $1`, [byStatus.get("issued")])).rejects.toThrow(
      /UPDATE on quote_service.quote_lines is not allowed: quote is issued/
    );
    await client.query(`delete from quote_service.quote_shipping where quote_id = $1`, [draft]);
    await insertShipping(client, draft);
  }, TEST_TIMEOUT_MS);

  it("an insert racing a draft → issuing transition waits for it and is rejected (parent row read FOR SHARE)", async () => {
    const url = await migratedDatabase();
    const issuer = await connect(url);
    const writer = await connect(url);
    const quoteId = await newDraft(issuer);

    await issuer.query("begin");
    await issuer.query(`select 1 from quote_service.quotes where quote_id = $1 for update`, [quoteId]);
    await acceptForIssue(issuer, quoteId);

    let settled = false;
    const racingInsert = insertLine(writer, quoteId).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    await issuer.query("commit");
    await expect(racingInsert).rejects.toThrow(/INSERT on quote_service.quote_lines is not allowed: quote is issuing/);
    expect((await issuer.query(`select count(*)::int as n from quote_service.quote_lines where quote_id = $1`, [quoteId])).rows[0]).toEqual({ n: 0 });
  }, TEST_TIMEOUT_MS);
});
