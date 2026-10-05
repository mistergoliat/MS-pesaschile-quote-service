// R1.4: Quote-owned migration integrity metadata. node-pg-migrate's
// schema_migrations stores names only; this table stores the content checksum
// of every applied migration so that "same name, changed bytes" is detectable.
// Rows are written by the explicit migration command (migrator.ts), never by
// the server. See docs/v2-persistence.md §Migration integrity.

exports.up = (pgm) => {
  pgm.sql(`
    create table quote_service.schema_migration_checksums (
      name text primary key,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      -- applied: recorded by the run that applied the migration.
      -- backfilled: recorded later for a migration applied before integrity
      -- tracking existed (000001-000005 on a pre-R1.4 database, and 000006
      -- itself), trusting the packaged file at that moment.
      provenance text not null check (provenance in ('applied', 'backfilled')),
      recorded_at timestamptz not null default now(),
      recorded_by text not null default current_user
    );

    comment on table quote_service.schema_migration_checksums is
      'Content checksum (SHA-256, CRLF normalized to LF) of each applied migration. Append-only.';

    create function quote_service.reject_mutation() returns trigger
    language plpgsql as $$
    begin
      raise exception '% on %.% is not allowed (append-only / immutable)',
        tg_op, tg_table_schema, tg_table_name
        using errcode = '55000';
    end;
    $$;

    create trigger schema_migration_checksums_append_only
      before update or delete on quote_service.schema_migration_checksums
      for each row execute function quote_service.reject_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table quote_service.schema_migration_checksums;
    drop function quote_service.reject_mutation();
  `);
};
