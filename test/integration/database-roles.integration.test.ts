import crypto from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRuntimeGrants, runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { PostgresDependencyProbe } from "../../src/infrastructure/persistence/postgres/postgres-dependency-probe";
import { loadMigrationManifest } from "../../src/infrastructure/persistence/postgres/schema-head";

// Disposable local roles only; credentials are random per run and never leave
// the test process. Production roles are provisioned out of band
// (docs/v2-persistence.md §Database roles).
const suffix = crypto.randomBytes(4).toString("hex");
const MIGRATOR = `quote_migrator_t${suffix}`;
const RUNTIME_LOGIN = `quote_app_t${suffix}`;
const MIGRATOR_PASSWORD = crypto.randomBytes(12).toString("hex");
const RUNTIME_PASSWORD = crypto.randomBytes(12).toString("hex");
const DATABASE = `quote_roles_t${suffix}`;

const adminUrl = () => process.env.TEST_DATABASE_ADMIN_URL!;
const urlFor = (user: string, password: string) => {
  const url = new URL(adminUrl());
  url.username = user;
  url.password = password;
  url.pathname = `/${DATABASE}`;
  return url.toString();
};

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();

  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

let runtime: pg.Client;

beforeAll(async () => {
  await admin(async (client) => {
    // Group role holding runtime privileges (cluster-wide, NOLOGIN, no secret).
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'quote_runtime') then
        create role quote_runtime nologin;
      end if;
    end $$`);
    await client.query(`create role ${MIGRATOR} login password '${MIGRATOR_PASSWORD}'`);
    await client.query(`create role ${RUNTIME_LOGIN} login password '${RUNTIME_PASSWORD}' in role quote_runtime`);
    // The migration principal owns the database (needed for schema creation,
    // the trusted pgcrypto extension and public.schema_migrations).
    await client.query(`create database ${DATABASE} owner ${MIGRATOR}`);
  });

  // N. The migration role can migrate.
  await runMigrations({ databaseUrl: urlFor(MIGRATOR, MIGRATOR_PASSWORD), direction: "up" });

  runtime = new pg.Client({ connectionString: urlFor(RUNTIME_LOGIN, RUNTIME_PASSWORD) });
  await runtime.connect();
}, 60_000);

afterAll(async () => {
  await runtime?.end().catch(() => undefined);
  await admin(async (client) => {
    await client.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [DATABASE]);
    await client.query(`drop database if exists ${DATABASE}`);
    await client.query(`drop role if exists ${RUNTIME_LOGIN}`);
    await client.query(`drop role if exists ${MIGRATOR}`);
  });
}, 60_000);

const PERMISSION_DENIED = /permission denied|must be owner/;

describe("database roles", () => {
  it("N: the migration role applied every migration and owns the objects", async () => {
    const owners = await admin(async () => {
      const client = new pg.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PASSWORD) });
      await client.connect();

      try {
        return (
          await client.query<{ owner: string; recorded_by: string }>(
            `select (select tableowner from pg_tables where schemaname = 'quote_service' and tablename = 'quotes') as owner,
                    (select min(recorded_by) from quote_service.schema_migration_checksums) as recorded_by`
          )
        ).rows[0];
      } finally {
        await client.end();
      }
    });

    expect(owners).toEqual({ owner: MIGRATOR, recorded_by: MIGRATOR });
  }, 30_000);

  it("P: the runtime role can perform the required DML and read the schema head", async () => {
    const quoteId = crypto.randomUUID();
    await runtime.query("begin");
    await runtime.query(
      `insert into quote_service.quotes (
         quote_id, status, version, currency, source_system, customer, net_amount, tax_amount, gross_amount,
         exempt_net_amount, created_by_principal_id, created_at, updated_at
       ) values ($1, 'draft', 1, 'CLP', 'sales-integration', '{"kind":"guest"}', 0, 0, 0, 0, 'sales-integration', now(), now())`,
      [quoteId]
    );
    await runtime.query(
      `insert into quote_service.quote_lines (
         line_id, quote_id, position, kind, item_source_system, item_description, quantity, quantity_unit,
         unit_amount, tax_basis, tax_rate, net_amount, tax_amount, gross_amount
       ) values ($1, $2, 1, 'product', 'pesaschile-catalog', 'Item', 1, 'unit', 1190, 'included', 0.19, 1000, 190, 1190)`,
      [crypto.randomUUID(), quoteId]
    );
    await runtime.query(`update quote_service.quotes set version = 2, net_amount = 1000, tax_amount = 190, gross_amount = 1190 where quote_id = $1`, [quoteId]);
    await runtime.query(`delete from quote_service.quote_lines where quote_id = $1`, [quoteId]);
    await runtime.query(
      `insert into quote_service.quote_audit_events (event_id, quote_id, sequence, event_type, occurred_at, principal_id, data)
       values ($1, $2, 1, 'quote.draft.created', now(), 'sales-integration', '{}')`,
      [crypto.randomUUID(), quoteId]
    );
    const sequence = await runtime.query<{ value: string }>(`select nextval('quote_service.quote_number_seq')::text as value`);
    await runtime.query("commit");

    expect(Number(sequence.rows[0]!.value)).toBeGreaterThanOrEqual(1);
    const probe = await new PostgresDependencyProbe(
      { connectionString: urlFor(RUNTIME_LOGIN, RUNTIME_PASSWORD) },
      loadMigrationManifest()
    ).probe(5_000);
    expect(probe).toEqual({
      connection: { ok: true },
      schema: { state: "READY", actualHead: "000008_quote_v2_runtime_grants" }
    });
  }, 30_000);

  it.each([
    ["alter a table", `alter table quote_service.quotes add column hacked text`],
    ["drop a table", `drop table quote_service.quote_audit_events`],
    ["create a table in quote_service", `create table quote_service.hacked (id int)`],
    ["create a table in public", `create table public.hacked (id int)`],
    ["truncate", `truncate quote_service.quotes`],
    ["delete quotes", `delete from quote_service.quotes`],
    ["update append-only audit", `update quote_service.quote_audit_events set principal_id = 'x'`],
    ["update the migration bookkeeping", `update public.schema_migrations set name = name`],
    ["read legacy evidence", `select * from quote_service.quote_legacy_v1`],
    ["re-grant itself", `select quote_service.apply_runtime_grants()`],
    ["alter the sequence", `alter sequence quote_service.quote_number_seq restart with 1`]
  ])("O: the runtime role cannot %s", async (_label, sql) => {
    await expect(runtime.query(sql)).rejects.toThrow(PERMISSION_DENIED);
  });

  it("db:grants re-applies runtime grants idempotently (role provisioned after migration)", async () => {
    const result = await applyRuntimeGrants(urlFor(MIGRATOR, MIGRATOR_PASSWORD));

    expect(result).toEqual({ runtimeRolePresent: true });
    await expect(runtime.query(`select count(*) from quote_service.quotes`)).resolves.toBeDefined();
    await expect(runtime.query(`select * from quote_service.quote_legacy_v1`)).rejects.toThrow(PERMISSION_DENIED);
  }, 30_000);
});
