// R1.4: runtime privilege separation.
//
// Roles (provisioned outside migrations, never by the service; see
// docs/v2-persistence.md §Database roles):
//   - migration principal: owns the database objects (runs db:migrate);
//   - quote_runtime: NOLOGIN group role holding the runtime privileges; the
//     service's login role is a member of it.
//
// quote_service.apply_runtime_grants() is idempotent. It resets and grants
// exactly the privileges the runtime needs: DML on Quote tables (no DELETE
// except draft lines/shipping, no UPDATE on append-only tables), sequence
// usage for number allocation, read access to migration metadata for the
// readiness probe, and nothing on legacy evidence. Ownership stays with the
// migration principal, so the runtime can never ALTER/DROP/CREATE schema
// objects. If quote_runtime does not exist yet the grants are skipped with a
// notice; run `npm run db:grants` after provisioning it.

const SQL = String.raw`
create function quote_service.apply_runtime_grants() returns void
language plpgsql as $f$
begin
  if not exists (select 1 from pg_roles where rolname = 'quote_runtime') then
    raise notice 'role quote_runtime does not exist; runtime grants skipped';
    return;
  end if;

  revoke all on all tables in schema quote_service from quote_runtime;
  revoke all on all sequences in schema quote_service from quote_runtime;
  revoke all on all functions in schema quote_service from quote_runtime;
  revoke all on schema quote_service from quote_runtime;

  grant usage on schema quote_service to quote_runtime;

  grant select, insert, update on
    quote_service.quotes,
    quote_service.issuance_operations,
    quote_service.quote_deliveries
  to quote_runtime;

  -- Draft edits replace lines/shipping (guard trigger rejects non-drafts).
  grant select, insert, update, delete on
    quote_service.quote_lines,
    quote_service.quote_shipping
  to quote_runtime;

  -- Append-only / immutable.
  grant select, insert on
    quote_service.quote_documents,
    quote_service.quote_audit_events,
    quote_service.idempotency_bindings
  to quote_runtime;

  -- Readiness: schema head and migration integrity.
  grant select on quote_service.schema_migration_checksums to quote_runtime;
  grant select on public.schema_migrations to quote_runtime;

  -- Quote number allocation (nextval).
  grant usage, select on sequence quote_service.quote_number_seq to quote_runtime;

  -- quote_service.quote_legacy_v1: deliberately no grant (operator access only).
end;
$f$;

revoke all on function quote_service.apply_runtime_grants() from public;
revoke all on function quote_service.reject_mutation() from public;

select quote_service.apply_runtime_grants();
`;

exports.up = (pgm) => {
  pgm.sql(SQL);
};

exports.down = (pgm) => {
  pgm.sql(String.raw`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'quote_runtime') then
        revoke all on all tables in schema quote_service from quote_runtime;
        revoke all on all sequences in schema quote_service from quote_runtime;
        revoke all on schema quote_service from quote_runtime;
        revoke all on public.schema_migrations from quote_runtime;
      end if;
    end $$;
    drop function quote_service.apply_runtime_grants();
  `);
};
