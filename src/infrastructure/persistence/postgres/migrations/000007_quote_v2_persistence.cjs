// R1.4: V2 persistence schema and one-way V1 -> V2 data migration.
//
// Normative inputs: docs/v2/QUOTE_V2_V1_MIGRATION.md (mapping),
// docs/v2/openapi.yaml (shapes), QUOTE_V2_STATE_MACHINE.md,
// QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md. Implementation notes:
// docs/v2-persistence.md.
//
// One transaction (node-pg-migrate singleTransaction):
//   1. stage V1 rows in temporary tables
//   2. validate every V1 row against the frozen mapping; any violation aborts
//      the whole migration with an exception report (quote ids + codes only,
//      never customer data) and nothing changes
//   3. drop the V1 tables (quote_number_seq is kept and never reset)
//   4. create the V2 tables
//   5. transform the staged rows (deterministic: ids derived from V1 ids)
//   6. verify post-conditions
//   7. install integrity triggers
//
// Irreversible by design: production recovery is backup -> restore -> forward
// migration (docs/v2-persistence.md §Recovery).

const SQL = String.raw`
-- =====================================================================
-- 0. Preconditions
-- =====================================================================
do $$
begin
  if to_regclass('quote_service.quotes') is null
     or to_regclass('quote_service.quote_lines') is null
     or to_regclass('quote_service.idempotency_keys') is null
     or to_regclass('quote_service.quote_audit_events') is null
     or to_regclass('quote_service.quote_deliveries') is null
     or to_regclass('quote_service.quote_email_outbox') is null
     or to_regclass('quote_service.quote_number_seq') is null then
    raise exception 'V1 schema (000001-000005) not found; refusing to migrate';
  end if;
end $$;

-- =====================================================================
-- 1. Stage V1 rows
-- =====================================================================
create temporary table v1_quotes on commit drop as select * from quote_service.quotes;
create temporary table v1_lines on commit drop as select * from quote_service.quote_lines;
create temporary table v1_idempotency on commit drop as select * from quote_service.idempotency_keys;
create temporary table v1_audit on commit drop as select * from quote_service.quote_audit_events;
create temporary table v1_deliveries on commit drop as select * from quote_service.quote_deliveries;

-- =====================================================================
-- 2. Helpers (session-scoped) and validation
-- =====================================================================
-- Contract patterns (docs/v2/openapi.yaml components/schemas).
create function pg_temp.is_text(v text, max_len int) returns boolean language sql immutable as $f$
  select v is not null
     and char_length(v) between 1 and max_len
     and v ~ '^[^\s\x01-\x1F\x7F](?:[^\x01-\x1F\x7F]*[^\s\x01-\x1F\x7F])?$'
$f$;
create function pg_temp.is_system_code(v text) returns boolean language sql immutable as $f$
  select v is not null and v ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
$f$;
create function pg_temp.is_opaque_ref(v text) returns boolean language sql immutable as $f$
  select v is not null and char_length(v) <= 200 and v ~ '^[!-~](?:[ -~]{0,198}[!-~])?$'
$f$;
create function pg_temp.is_email(v text) returns boolean language sql immutable as $f$
  select v is not null and char_length(v) <= 254
     and v ~* '^[a-z0-9!#$%&''*+/=?^_{|}~-]+(?:\.[a-z0-9!#$%&''*+/=?^_{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
$f$;
create function pg_temp.is_phone(v text) returns boolean language sql immutable as $f$
  select v is not null and v ~ '^\+?[0-9][0-9 ()-]{5,19}$'
$f$;
create function pg_temp.is_sha256(v text) returns boolean language sql immutable as $f$
  select v is not null and v ~ '^[0-9a-f]{64}$'
$f$;
create function pg_temp.blank_to_null(v text) returns text language sql immutable as $f$
  select case when v is null or v = '' then null else v end
$f$;

-- Normative arithmetic (Domain contract §6.3), exact integers:
--   halfUp(n, d) = floor((2n + d) / (2d)); Q = quantity x 10^6; R = rate x 10^6.
create function pg_temp.v2_charge(unit numeric, qty numeric, basis text, rate numeric,
  out net numeric, out tax numeric, out gross numeric) language plpgsql immutable as $f$
declare
  ext numeric := div(2 * unit * (qty * 1000000) + 1000000, 2000000);
  r numeric := coalesce(rate, 0) * 1000000;
begin
  if basis = 'exempt' then
    net := ext; tax := 0; gross := ext;
  elsif basis = 'included' then
    gross := ext;
    net := div(2 * ext * 1000000 + (1000000 + r), 2 * (1000000 + r));
    tax := gross - net;
  else
    net := ext;
    tax := div(2 * ext * r + 1000000, 2000000);
    gross := net + tax;
  end if;
end $f$;

-- A V1 quote is "committed" (a formal issue happened, so it keeps its number,
-- validity, issuance and document) when it is not a draft and has issued_at.
-- A V1 cancelled quote without issued_at was a cancelled draft.
create temporary table m_quotes on commit drop as
select
  q.quote_id,
  (q.status <> 'draft' and q.issued_at is not null) as committed,
  case q.status
    when 'draft' then 'draft'
    when 'issued' then 'issued'
    when 'accepted' then 'issued'
    when 'paid' then 'issued'
    when 'cancelled' then 'cancelled'
    when 'expired' then 'expired'
  end as v2_status,
  case when q.source_system = 'crm_customer_360' then 'crm_customer_360' else 'legacy-v1' end as v2_source_system
from v1_quotes q;

create temporary table m_lines on commit drop as
select
  l.line_id,
  l.quote_id,
  l.display_order + 1 as position,
  case when l.type = 'shipping' then 'service' else l.type end as kind,
  case
    when l.type = 'shipping' then 'legacy-v1-shipping'
    when l.external_source is null then 'legacy-v1'
    else l.external_source
  end as item_source_system,
  l.external_item_id as item_product_ref,
  l.external_variant_id as item_variant_ref,
  l.sku as item_sku,
  l.description as item_description,
  l.quantity,
  l.unit_price as unit_amount,
  case when l.tax_rate = 0 then 'exempt' when l.tax_included then 'included' else 'excluded' end as tax_basis,
  case when l.tax_rate = 0 then null else l.tax_rate end as tax_rate,
  c.net, c.tax, c.gross,
  l.line_subtotal, l.line_tax, l.line_total
from v1_lines l
cross join lateral pg_temp.v2_charge(
  l.unit_price,
  l.quantity,
  case when l.tax_rate = 0 then 'exempt' when l.tax_included then 'included' else 'excluded' end,
  l.tax_rate
) c;

create temporary table m_totals on commit drop as
select
  q.quote_id,
  coalesce(sum(l.net), 0) as net,
  coalesce(sum(l.tax), 0) as tax,
  coalesce(sum(l.gross), 0) as gross,
  coalesce(sum(l.net) filter (where l.tax_basis = 'exempt'), 0) as exempt_net,
  count(l.line_id) as line_count
from v1_quotes q
left join m_lines l on l.quote_id = q.quote_id
group by q.quote_id;

create temporary table m_customers on commit drop as
select
  s.quote_id,
  s.company,
  s.name, s.business_name, s.email, s.phone, s.address, s.district, s.region,
  s.customer_id,
  pg_temp.is_email(s.email) as email_ok,
  pg_temp.is_phone(s.phone) as phone_ok,
  pg_temp.is_opaque_ref(s.customer_id) as customer_ref_ok
from (
  select
    q.quote_id,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'businessName') is not null as company,
    q.customer_snapshot ->> 'name' as name,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'businessName') as business_name,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'email') as email,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'phone') as phone,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'address') as address,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'district') as district,
    pg_temp.blank_to_null(q.customer_snapshot ->> 'region') as region,
    pg_temp.blank_to_null(q.customer_id) as customer_id
  from v1_quotes q
) s;

-- Exception report. Codes and ids only: never customer values.
create temporary table m_exceptions (quote_id uuid, code text not null, detail text) on commit drop;

insert into m_exceptions (quote_id, code, detail)
select q.quote_id, 'issued_without_issued_at', q.status
from v1_quotes q
where q.status in ('issued', 'accepted', 'paid', 'expired') and q.issued_at is null
union all
select q.quote_id, 'document_missing', q.status
from v1_quotes q join m_quotes m using (quote_id)
where m.committed and q.issued_pdf_sha256 is null
union all
select q.quote_id, 'document_metadata_invalid', null
from v1_quotes q join m_quotes m using (quote_id)
where m.committed and q.issued_pdf_sha256 is not null and not (
  pg_temp.is_sha256(q.issued_pdf_sha256)
  and pg_temp.is_sha256(q.issued_content_hash)
  and q.issued_pdf_storage_key is not null
  and q.issued_render_version is not null
  and char_length(q.issued_render_version) <= 100
  and q.issued_document_generated_at is not null
)
union all
select q.quote_id, 'cancelled_without_cancelled_at', null
from v1_quotes q where q.status = 'cancelled' and q.cancelled_at is null
union all
select q.quote_id, 'expired_without_expired_at', null
from v1_quotes q where q.status = 'expired' and q.expired_at is null
union all
select q.quote_id, 'validity_not_after_issue', null
from v1_quotes q join m_quotes m using (quote_id)
where m.committed and q.valid_until <= q.issued_at
union all
select q.quote_id, 'quote_number_invalid', null
from v1_quotes q join m_quotes m using (quote_id)
where m.committed and q.quote_number !~ '^[A-Z]{2,8}-[0-9]{6,}$'
union all
select q.quote_id, 'external_reference_invalid', 'opportunity_id'
from v1_quotes q where not pg_temp.is_opaque_ref(q.opportunity_id)
union all
select c.quote_id, 'customer_field_invalid', f.field
from m_customers c
cross join lateral (values
  ('name', c.name is not null and not pg_temp.is_text(c.name, 200)),
  ('name', c.name is null and not c.company),
  ('businessName', c.business_name is not null and not pg_temp.is_text(c.business_name, 200)),
  ('address', c.address is not null and not pg_temp.is_text(c.address, 120)),
  ('district', c.district is not null and not pg_temp.is_text(c.district, 80)),
  ('region', c.region is not null and not pg_temp.is_text(c.region, 80))
) as f(field, violated)
where f.violated
union all
select l.quote_id, 'line_description_invalid', l.line_id::text
from m_lines l where not pg_temp.is_text(l.item_description, 300)
union all
select l.quote_id, 'line_sku_invalid', l.line_id::text
from m_lines l where l.item_sku is not null and not pg_temp.is_text(l.item_sku, 100)
union all
select l.quote_id, 'line_source_system_invalid', l.line_id::text
from m_lines l where not pg_temp.is_system_code(l.item_source_system)
union all
select l.quote_id, 'line_item_reference_invalid', l.line_id::text
from m_lines l
where (l.item_product_ref is not null and not pg_temp.is_opaque_ref(l.item_product_ref))
   or (l.item_variant_ref is not null and not pg_temp.is_opaque_ref(l.item_variant_ref))
union all
select l.quote_id, 'line_quantity_out_of_range', l.line_id::text
from m_lines l where not (l.quantity > 0 and l.quantity < 10000)
union all
select l.quote_id, 'line_unit_amount_out_of_range', l.line_id::text
from m_lines l where not (l.unit_amount between 0 and 1000000000)
union all
select l.quote_id, 'line_tax_rate_out_of_range', l.line_id::text
from m_lines l where l.tax_rate is not null and not (l.tax_rate > 0 and l.tax_rate <= 1)
union all
select l.quote_id, 'line_arithmetic_mismatch', l.line_id::text
from m_lines l
where l.net <> l.line_subtotal or l.tax <> l.line_tax or l.gross <> l.line_total
union all
select q.quote_id, 'totals_arithmetic_mismatch', null
from v1_quotes q join m_totals t using (quote_id)
where t.net <> q.subtotal or t.tax <> q.tax_amount or t.gross <> q.total
union all
select t.quote_id, 'totals_out_of_range', null
from m_totals t where t.gross > 9007199254740991
union all
select t.quote_id, 'line_count_out_of_range', t.line_count::text
from m_totals t where t.line_count > 100
union all
select null, 'idempotency_request_hash_invalid', k.operation_name
from v1_idempotency k where k.status = 'completed' and not pg_temp.is_sha256(k.request_hash)
union all
select null, 'idempotency_resource_unresolved', k.operation_name
from v1_idempotency k
where k.status = 'completed' and (
  k.resource_id is null
  or (k.resource_type = 'quote' and not exists (select 1 from v1_quotes q where q.quote_id = k.resource_id))
  or (k.resource_type = 'quote_delivery' and not exists (select 1 from v1_deliveries d where d.delivery_id = k.resource_id))
  or k.resource_type not in ('quote', 'quote_delivery')
  or k.resource_type is null
)
union all
select d.quote_id, 'delivery_without_document', d.delivery_id::text
from v1_deliveries d join v1_quotes q using (quote_id)
where q.issued_pdf_sha256 is null or not pg_temp.is_sha256(q.issued_pdf_sha256)
union all
select d.quote_id, 'delivery_sent_without_sent_at', d.delivery_id::text
from v1_deliveries d where d.status = 'sent' and d.sent_at is null;

do $$
declare
  total integer;
  report text;
begin
  select count(*) into total from m_exceptions;

  if total > 0 then
    select string_agg(format('  %s %s %s', coalesce(quote_id::text, '-'), code, coalesce(detail, '')), E'\n')
      into report
      from (select * from m_exceptions order by quote_id nulls first, code, detail limit 100) e;
    raise exception E'V1 -> V2 migration exceptions: % row(s) violate the frozen mapping; nothing was migrated.\n%', total, report
      using errcode = 'P0001';
  end if;
end $$;

-- =====================================================================
-- 3. Drop the V1 tables (no shadow V1 tables). quote_number_seq is kept.
-- =====================================================================
drop table quote_service.quote_email_outbox;
drop table quote_service.quote_deliveries;
drop table quote_service.quote_audit_events;
drop table quote_service.idempotency_keys;
drop table quote_service.quote_lines;
drop table quote_service.quotes;

-- The sequence becomes bigint explicitly (it already is by default) and is
-- never reset: V2 continues from the current value; V1 numbers are never reused.
alter sequence quote_service.quote_number_seq as bigint;

-- =====================================================================
-- 4. V2 schema
-- =====================================================================
create table quote_service.quotes (
  quote_id uuid primary key,
  status text not null
    constraint quotes_status_check check (status in ('draft', 'issuing', 'issued', 'expired', 'cancelled')),
  version integer not null constraint quotes_version_check check (version >= 1),
  quote_number text
    constraint quotes_quote_number_format check (quote_number ~ '^[A-Z]{2,8}-[0-9]{6,}$'),
  currency text not null constraint quotes_currency_check check (currency = 'CLP'),

  -- Durable business correlation (externalCorrelation). Request/trace
  -- correlation is never stored on the quote (contract amendment A3).
  source_system text not null
    constraint quotes_source_system_check check (source_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  external_reference_type text
    constraint quotes_external_reference_type_check check (external_reference_type ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  external_reference text
    constraint quotes_external_reference_check check (char_length(external_reference) <= 200 and external_reference ~ '^[!-~](?:[ -~]{0,198}[!-~])?$'),

  -- Quote-specific customer snapshot (guest | person | company); validated
  -- in depth by the application against the frozen schema.
  customer jsonb not null
    constraint quotes_customer_check check (jsonb_typeof(customer) = 'object' and customer ->> 'kind' in ('guest', 'person', 'company')),

  net_amount bigint not null,
  tax_amount bigint not null,
  gross_amount bigint not null,
  exempt_net_amount bigint not null,

  -- Issuance (null until issue acceptance).
  issued_at timestamptz,
  issuer_profile_id text
    constraint quotes_issuer_profile_check check (issuer_profile_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  current_operation_id uuid,

  -- Owner validity, frozen at issue acceptance.
  validity_source text
    constraint quotes_validity_source_check check (validity_source in ('policy', 'override', 'legacy_caller_supplied')),
  validity_policy_id text
    constraint quotes_validity_policy_check check (validity_policy_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  validity_issuer_zone text
    constraint quotes_validity_issuer_zone_check check (validity_issuer_zone = 'America/Santiago'),
  validity_tzdb_version text
    constraint quotes_validity_tzdb_check check (validity_tzdb_version ~ '^[0-9]{4}[a-z]$'),
  validity_issue_local_date date,
  validity_through_local_date date,
  valid_until_exclusive timestamptz,
  validity_override_principal_id text
    constraint quotes_validity_override_principal_check check (validity_override_principal_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  validity_override_reason_code text
    constraint quotes_validity_override_reason_check check (validity_override_reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  validity_override_note text
    constraint quotes_validity_override_note_check check (char_length(validity_override_note) <= 500),

  cancelled_at timestamptz,
  cancellation_reason_code text
    constraint quotes_cancellation_reason_check check (cancellation_reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  cancellation_initiated_by text
    constraint quotes_cancellation_initiated_by_check check (cancellation_initiated_by ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),

  expired_at timestamptz,

  created_by_principal_id text not null
    constraint quotes_created_by_check check (created_by_principal_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,

  constraint quotes_quote_number_unique unique (quote_number),
  constraint quotes_external_reference_pair check ((external_reference_type is null) = (external_reference is null)),
  constraint quotes_amounts_check check (
    net_amount >= 0 and tax_amount >= 0 and exempt_net_amount >= 0
    and exempt_net_amount <= net_amount
    and gross_amount = net_amount + tax_amount
    and gross_amount <= 9007199254740991
  ),
  -- Issue acceptance sets number, issuance and validity together.
  constraint quotes_issue_acceptance_atomic check (
    (quote_number is null and issued_at is null and issuer_profile_id is null and current_operation_id is null
      and validity_source is null and validity_issuer_zone is null and validity_issue_local_date is null
      and validity_through_local_date is null and valid_until_exclusive is null)
    or
    (quote_number is not null and issued_at is not null and issuer_profile_id is not null and current_operation_id is not null
      and validity_source is not null and validity_issuer_zone is not null and validity_issue_local_date is not null
      and validity_through_local_date is not null and valid_until_exclusive is not null)
  ),
  constraint quotes_status_requires_acceptance check (
    case status
      when 'draft' then quote_number is null
      when 'issuing' then quote_number is not null
      when 'issued' then quote_number is not null
      when 'expired' then quote_number is not null
      else true
    end
  ),
  constraint quotes_validity_source_shape check (
    validity_source is null
    or (validity_source = 'policy' and validity_policy_id is not null and validity_tzdb_version is not null
        and validity_override_principal_id is null and validity_override_reason_code is null and validity_override_note is null)
    or (validity_source = 'override' and validity_tzdb_version is not null
        and validity_override_principal_id is not null and validity_override_reason_code is not null)
    or (validity_source = 'legacy_caller_supplied' and validity_policy_id is null and validity_tzdb_version is null
        and validity_override_principal_id is null and validity_override_reason_code is null and validity_override_note is null)
  ),
  constraint quotes_validity_dates check (
    validity_through_local_date is null or validity_through_local_date >= validity_issue_local_date
  ),
  constraint quotes_validity_after_issue check (valid_until_exclusive is null or valid_until_exclusive > issued_at),
  constraint quotes_cancellation_atomic check (
    (cancelled_at is null and cancellation_reason_code is null and cancellation_initiated_by is null)
    or (cancelled_at is not null and cancellation_reason_code is not null and cancellation_initiated_by is not null)
  ),
  constraint quotes_cancelled_iff_cancellation check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint quotes_expired_iff_expiration check ((status = 'expired') = (expired_at is not null))
);

comment on column quote_service.quotes.quote_number is
  'Owner business identifier. Null until issue acceptance; unique when present; allocated from quote_number_seq (never reset).';

-- GET /v2/quotes?sourceSystem&externalReferenceType&externalReference (createdAt desc, quoteId).
create index quotes_external_correlation_idx
  on quote_service.quotes (source_system, external_reference_type, external_reference, created_at desc, quote_id desc);
-- Expiry materialization job: stored issued quotes past validUntilExclusive.
create index quotes_issued_validity_idx
  on quote_service.quotes (valid_until_exclusive) where status = 'issued';

create table quote_service.quote_lines (
  line_id uuid primary key,
  quote_id uuid not null references quote_service.quotes (quote_id),
  position integer not null constraint quote_lines_position_check check (position between 1 and 100),
  kind text not null constraint quote_lines_kind_check check (kind in ('product', 'service')),
  item_source_system text not null
    constraint quote_lines_item_source_check check (item_source_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  item_product_ref text constraint quote_lines_product_ref_check check (char_length(item_product_ref) <= 200),
  item_variant_ref text constraint quote_lines_variant_ref_check check (char_length(item_variant_ref) <= 200),
  item_sku text constraint quote_lines_sku_check check (char_length(item_sku) <= 100),
  item_description text not null
    constraint quote_lines_description_check check (char_length(item_description) between 1 and 300),
  item_attributes jsonb not null default '[]'::jsonb
    constraint quote_lines_attributes_check check (jsonb_typeof(item_attributes) = 'array' and jsonb_array_length(item_attributes) <= 10),
  -- Exact decimal quantity: > 0, < 10000, at most 6 fractional digits.
  quantity numeric(10, 6) not null constraint quote_lines_quantity_check check (quantity > 0 and quantity < 10000),
  quantity_unit text not null constraint quote_lines_unit_check check (quantity_unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  -- Whole CLP pesos; exact decimal tax rate in (0, 1], absent for exempt.
  unit_amount bigint not null constraint quote_lines_unit_amount_check check (unit_amount between 0 and 1000000000),
  tax_basis text not null constraint quote_lines_tax_basis_check check (tax_basis in ('included', 'excluded', 'exempt')),
  tax_rate numeric(7, 6) constraint quote_lines_tax_rate_check check (tax_rate > 0 and tax_rate <= 1),
  pricing_source_system text
    constraint quote_lines_pricing_source_check check (pricing_source_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  pricing_reference text constraint quote_lines_pricing_reference_check check (char_length(pricing_reference) <= 200),
  pricing_as_of timestamptz,
  net_amount bigint not null,
  tax_amount bigint not null,
  gross_amount bigint not null,
  constraint quote_lines_position_unique unique (quote_id, position),
  constraint quote_lines_tax_rate_by_basis check ((tax_basis = 'exempt') = (tax_rate is null)),
  constraint quote_lines_pricing_provenance check (
    (pricing_source_system is null and pricing_reference is null and pricing_as_of is null)
    or (pricing_source_system is not null and pricing_as_of is not null)
  ),
  constraint quote_lines_amounts_check check (
    net_amount >= 0 and tax_amount >= 0 and gross_amount = net_amount + tax_amount
    and (tax_basis <> 'exempt' or tax_amount = 0)
  )
);

-- Structured shipping snapshot (0..1 per quote). Quote never calls Shipping;
-- every value is caller-resolved. No row is ever fabricated for V1 data.
create table quote_service.quote_shipping (
  quote_id uuid primary key references quote_service.quotes (quote_id),
  carrier_code text constraint quote_shipping_carrier_code_check check (carrier_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  carrier_name text not null constraint quote_shipping_carrier_name_check check (char_length(carrier_name) between 1 and 120),
  service_type_code text constraint quote_shipping_service_code_check check (service_type_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  service_type_name text constraint quote_shipping_service_name_check check (char_length(service_type_name) between 1 and 120),
  destination_commune text not null
    constraint quote_shipping_commune_check check (char_length(destination_commune) between 1 and 80),
  destination_region text constraint quote_shipping_region_check check (char_length(destination_region) between 1 and 80),
  destination_country text not null constraint quote_shipping_country_check check (destination_country = 'CL'),
  amount bigint not null constraint quote_shipping_amount_check check (amount between 0 and 1000000000),
  tax_basis text not null constraint quote_shipping_tax_basis_check check (tax_basis in ('included', 'excluded', 'exempt')),
  tax_rate numeric(7, 6) constraint quote_shipping_tax_rate_check check (tax_rate > 0 and tax_rate <= 1),
  source_quote_system text
    constraint quote_shipping_source_system_check check (source_quote_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  source_quote_reference text constraint quote_shipping_source_reference_check check (char_length(source_quote_reference) <= 200),
  source_quote_as_of timestamptz,
  net_amount bigint not null,
  tax_amount bigint not null,
  gross_amount bigint not null,
  constraint quote_shipping_tax_rate_by_basis check ((tax_basis = 'exempt') = (tax_rate is null)),
  constraint quote_shipping_source_quote check (
    (source_quote_system is null and source_quote_reference is null and source_quote_as_of is null)
    or (source_quote_system is not null and source_quote_as_of is not null)
  ),
  constraint quote_shipping_amounts_check check (
    net_amount >= 0 and tax_amount >= 0 and gross_amount = net_amount + tax_amount
    and (tax_basis <> 'exempt' or tax_amount = 0)
  )
);

-- Durable issuance operation. Lifecycle separate from the quote (amendment
-- A1): several operations per quote over time, at most one active and at
-- most one succeeded.
create table quote_service.issuance_operations (
  operation_id uuid primary key,
  quote_id uuid not null references quote_service.quotes (quote_id),
  operation_type text not null constraint issuance_operations_type_check check (operation_type = 'quote.issue'),
  origin text not null
    constraint issuance_operations_origin_check check (origin in ('acceptance', 'operator_retry', 'legacy_v1_migration')),
  retry_of_operation_id uuid references quote_service.issuance_operations (operation_id),
  status text not null
    constraint issuance_operations_status_check check (status in ('pending', 'running', 'succeeded', 'failed')),
  -- Fencing token: bumped by every claim and by the deadline sweep.
  generation bigint not null default 0 constraint issuance_operations_generation_check check (generation >= 0),
  lease_owner text constraint issuance_operations_lease_owner_check check (char_length(lease_owner) between 1 and 200),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 constraint issuance_operations_attempts_check check (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error_code text constraint issuance_operations_error_code_check check (last_error_code in (
    'document_generation_failed', 'document_storage_failed', 'dependency_unavailable', 'issuance_deadline_exceeded'
  )),
  next_attempt_at timestamptz,
  accepted_at timestamptz not null,
  deadline_at timestamptz not null,
  completed_at timestamptz,
  -- Identity of what must be rendered: semantic hash of the frozen snapshot.
  snapshot_hash text not null constraint issuance_operations_snapshot_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot_hash_algorithm text not null
    constraint issuance_operations_hash_algorithm_check check (snapshot_hash_algorithm in ('jcs-sha256-v2', 'v1-canonical-json')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint issuance_operations_operation_quote_unique unique (operation_id, quote_id),
  constraint issuance_operations_deadline_after_acceptance check (deadline_at > accepted_at),
  constraint issuance_operations_lease_iff_running check (
    (status = 'running') = (lease_owner is not null and lease_expires_at is not null)
  ),
  constraint issuance_operations_terminal_iff_completed check (
    (status in ('succeeded', 'failed')) = (completed_at is not null)
  ),
  constraint issuance_operations_pending_schedule check (status <> 'pending' or next_attempt_at is not null),
  constraint issuance_operations_failed_has_code check (status <> 'failed' or last_error_code is not null),
  constraint issuance_operations_attempted check (
    status not in ('running', 'succeeded') or attempt_count >= 1 or origin = 'legacy_v1_migration'
  ),
  constraint issuance_operations_generation_covers_attempts check (generation >= attempt_count),
  constraint issuance_operations_retry_lineage check ((origin = 'operator_retry') = (retry_of_operation_id is not null))
);

create unique index issuance_operations_one_active_per_quote
  on quote_service.issuance_operations (quote_id) where status in ('pending', 'running');
create unique index issuance_operations_one_succeeded_per_quote
  on quote_service.issuance_operations (quote_id) where status = 'succeeded';
-- Claim: pending operations whose next attempt is due.
create index issuance_operations_pending_due_idx
  on quote_service.issuance_operations (next_attempt_at) where status = 'pending';
-- Reclaim: running operations whose lease expired.
create index issuance_operations_running_lease_idx
  on quote_service.issuance_operations (lease_expires_at) where status = 'running';
-- Deadline sweep.
create index issuance_operations_active_deadline_idx
  on quote_service.issuance_operations (deadline_at) where status in ('pending', 'running');

alter table quote_service.quotes
  add constraint quotes_current_operation_fk
  foreign key (current_operation_id, quote_id)
  references quote_service.issuance_operations (operation_id, quote_id)
  deferrable initially deferred;

-- Immutable document manifest (one per quote, committed once).
create table quote_service.quote_documents (
  document_id uuid primary key,
  quote_id uuid not null,
  operation_id uuid not null,
  origin text not null constraint quote_documents_origin_check check (origin in ('issuance', 'legacy_v1')),
  content_type text not null constraint quote_documents_content_type_check check (content_type = 'application/pdf'),
  semantic_snapshot_hash text not null
    constraint quote_documents_snapshot_hash_check check (semantic_snapshot_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash_algorithm text not null
    constraint quote_documents_hash_algorithm_check check (semantic_hash_algorithm in ('jcs-sha256-v2', 'v1-canonical-json')),
  pdf_sha256 text not null constraint quote_documents_pdf_sha256_check check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  -- Unknown for legacy V1 artifacts until verified from the stored bytes.
  byte_length bigint constraint quote_documents_byte_length_check check (byte_length >= 1),
  renderer_version text not null constraint quote_documents_renderer_check check (char_length(renderer_version) between 1 and 100),
  template_version text not null constraint quote_documents_template_check check (char_length(template_version) between 1 and 100),
  generated_at timestamptz not null,
  artifact_ref text generated always as ('sha256:' || pdf_sha256) stored,
  -- Path of the bytes relative to the storage root.
  storage_key text not null constraint quote_documents_storage_key_check check (
    char_length(storage_key) between 1 and 500 and storage_key ~ '^[A-Za-z0-9._/-]+$' and storage_key !~ '\.\.'
  ),
  committed_at timestamptz not null,
  constraint quote_documents_quote_unique unique (quote_id),
  constraint quote_documents_operation_fk foreign key (operation_id, quote_id)
    references quote_service.issuance_operations (operation_id, quote_id),
  constraint quote_documents_byte_length_known check (origin = 'legacy_v1' or byte_length is not null),
  -- V2 artifacts live in the content-addressed layout.
  constraint quote_documents_content_addressed check (
    origin <> 'issuance'
    or storage_key = 'artifacts/sha256/' || substr(pdf_sha256, 1, 2) || '/' || substr(pdf_sha256, 3, 2) || '/' || pdf_sha256 || '.pdf'
  )
);

-- Append-only audit.
create table quote_service.quote_audit_events (
  event_id uuid primary key,
  quote_id uuid not null references quote_service.quotes (quote_id),
  sequence integer not null constraint quote_audit_events_sequence_check check (sequence >= 1),
  event_type text not null constraint quote_audit_events_type_check check (event_type in (
    'quote.draft.created', 'quote.draft.updated', 'quote.issue.accepted', 'quote.issue.attempt_failed',
    'quote.issued', 'quote.issue.failed', 'quote.cancelled', 'quote.expired',
    'quote.delivery.requested', 'quote.delivery.sent', 'quote.delivery.failed', 'quote.delivery.unknown',
    'idempotency.replayed', 'idempotency.conflict', 'legacy.v1.event'
  )),
  occurred_at timestamptz not null,
  principal_id text not null constraint quote_audit_events_principal_check check (principal_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  operation_id uuid references quote_service.issuance_operations (operation_id),
  -- Request/trace correlation (X-Correlation-Id) of the producing request.
  correlation_id text constraint quote_audit_events_correlation_check check (
    char_length(correlation_id) <= 200 and correlation_id ~ '^[!-~](?:[ -~]{0,198}[!-~])?$'
  ),
  idempotency_key_hash text constraint quote_audit_events_key_hash_check check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  from_status text constraint quote_audit_events_from_check check (from_status in ('draft', 'issuing', 'issued', 'expired', 'cancelled')),
  to_status text constraint quote_audit_events_to_check check (to_status in ('draft', 'issuing', 'issued', 'expired', 'cancelled')),
  data jsonb not null constraint quote_audit_events_data_check check (jsonb_typeof(data) = 'object'),
  constraint quote_audit_events_sequence_unique unique (quote_id, sequence)
);

-- Email deliveries (queue state lives on the delivery; worker redesign is R1.6).
create table quote_service.quote_deliveries (
  delivery_id uuid primary key,
  quote_id uuid not null references quote_service.quotes (quote_id),
  origin text not null constraint quote_deliveries_origin_check check (origin in ('v2', 'legacy_v1')),
  channel text not null constraint quote_deliveries_channel_check check (channel = 'email'),
  status text not null constraint quote_deliveries_status_check check (status in ('pending', 'sending', 'sent', 'failed', 'unknown')),
  recipient_email text not null constraint quote_deliveries_recipient_check check (char_length(recipient_email) between 1 and 320),
  recipient_name text constraint quote_deliveries_recipient_name_check check (char_length(recipient_name) <= 200),
  recipient_masked text not null constraint quote_deliveries_masked_check check (char_length(recipient_masked) between 1 and 254),
  document_sha256 text not null constraint quote_deliveries_document_check check (document_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by_principal_id text not null
    constraint quote_deliveries_requested_by_check check (requested_by_principal_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  generation bigint not null default 0 constraint quote_deliveries_generation_check check (generation >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 constraint quote_deliveries_attempts_check check (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error_code text constraint quote_deliveries_error_code_check check (last_error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  next_attempt_at timestamptz,
  provider_message_id text constraint quote_deliveries_provider_id_check check (char_length(provider_message_id) <= 500),
  requested_at timestamptz not null,
  sent_at timestamptz,
  updated_at timestamptz not null,
  constraint quote_deliveries_sent_iff_sent_at check ((status = 'sent') = (sent_at is not null)),
  constraint quote_deliveries_failed_has_code check (status <> 'failed' or last_error_code is not null),
  constraint quote_deliveries_lease_iff_sending check ((status = 'sending') = (lease_owner is not null and lease_expires_at is not null)),
  constraint quote_deliveries_pending_schedule check (status <> 'pending' or next_attempt_at is not null)
);

create index quote_deliveries_quote_idx on quote_service.quote_deliveries (quote_id);
create index quote_deliveries_pending_due_idx
  on quote_service.quote_deliveries (next_attempt_at) where status = 'pending';
create index quote_deliveries_sending_lease_idx
  on quote_service.quote_deliveries (lease_expires_at) where status = 'sending';

-- Idempotency bindings scoped by (principal, operation, SHA-256(key)).
create table quote_service.idempotency_bindings (
  principal_id text not null constraint idempotency_bindings_principal_check check (principal_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  operation text not null,
  key_hash text not null constraint idempotency_bindings_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  binding_kind text not null constraint idempotency_bindings_kind_check check (binding_kind in ('v2', 'legacy_v1')),
  request_fingerprint text not null
    constraint idempotency_bindings_fingerprint_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_algorithm text not null
    constraint idempotency_bindings_fingerprint_algorithm_check check (fingerprint_algorithm in ('jcs-sha256-v2', 'v1-request-hash')),
  -- Immutable full received body (V2 only; V1 snapshots are not migrated).
  request_snapshot jsonb,
  resource_type text not null constraint idempotency_bindings_resource_type_check check (resource_type in ('quote', 'delivery')),
  quote_id uuid not null references quote_service.quotes (quote_id),
  operation_id uuid references quote_service.issuance_operations (operation_id),
  delivery_id uuid references quote_service.quote_deliveries (delivery_id),
  bound_at timestamptz not null,
  constraint idempotency_bindings_pkey primary key (principal_id, operation, key_hash),
  constraint idempotency_bindings_v2_shape check (
    binding_kind <> 'v2' or (
      operation in ('quote.create_and_issue', 'quote.draft.create', 'quote.draft.update', 'quote.issue', 'quote.cancel', 'quote.delivery.email')
      and principal_id <> 'legacy-v1'
      and fingerprint_algorithm = 'jcs-sha256-v2'
      and request_snapshot is not null
      and (operation not in ('quote.create_and_issue', 'quote.issue') or operation_id is not null)
      and ((operation = 'quote.delivery.email') = (resource_type = 'delivery'))
    )
  ),
  constraint idempotency_bindings_legacy_shape check (
    binding_kind <> 'legacy_v1' or (
      principal_id = 'legacy-v1'
      and operation ~ '^legacy\.v1\.[a-z_]{1,64}$'
      and fingerprint_algorithm = 'v1-request-hash'
      and request_snapshot is null
    )
  ),
  constraint idempotency_bindings_resource_shape check ((resource_type = 'delivery') = (delivery_id is not null))
);

-- Owner-internal legacy V1 evidence, one append-only record per migrated
-- quote. Never part of the V2 API; no runtime grant.
create table quote_service.quote_legacy_v1 (
  quote_id uuid primary key references quote_service.quotes (quote_id),
  migrated_at timestamptz not null,
  data jsonb not null constraint quote_legacy_v1_data_check check (jsonb_typeof(data) = 'object')
);

-- =====================================================================
-- 5. Transform
-- =====================================================================
insert into quote_service.quotes (
  quote_id, status, version, quote_number, currency,
  source_system, external_reference_type, external_reference,
  customer,
  net_amount, tax_amount, gross_amount, exempt_net_amount,
  issued_at, issuer_profile_id, current_operation_id,
  validity_source, validity_policy_id, validity_issuer_zone, validity_tzdb_version,
  validity_issue_local_date, validity_through_local_date, valid_until_exclusive,
  cancelled_at, cancellation_reason_code, cancellation_initiated_by,
  expired_at, created_by_principal_id, created_at, updated_at
)
select
  q.quote_id,
  m.v2_status,
  q.version,
  case when m.committed then q.quote_number end,
  'CLP',
  m.v2_source_system,
  'opportunity',
  q.opportunity_id,
  jsonb_strip_nulls(jsonb_build_object(
    'kind', case when c.company then 'company' else 'person' end,
    'displayName', case when not c.company then c.name end,
    'legalName', case when c.company then c.business_name end,
    'contactName', case when c.company then c.name end,
    'email', case when c.email_ok then c.email end,
    'phone', case when c.phone_ok then c.phone end,
    'address', case when c.address is not null or c.district is not null then jsonb_strip_nulls(jsonb_build_object(
      'lines', case when c.address is not null then jsonb_build_array(c.address) end,
      'commune', c.district,
      'region', c.region,
      'country', 'CL'
    )) end,
    'externalCustomerReference', case when c.customer_ref_ok then jsonb_build_object(
      'sourceSystem', m.v2_source_system,
      'reference', c.customer_id
    ) end
  )),
  t.net, t.tax, t.gross, t.exempt_net,
  case when m.committed then q.issued_at end,
  case when m.committed then 'pesaschile-cl-v1' end,
  case when m.committed then md5('quote-v2-legacy-issuance:' || q.quote_id::text)::uuid end,
  -- Legacy validity: preserved as caller-supplied evidence, never recomputed.
  case when m.committed then 'legacy_caller_supplied' end,
  null,
  case when m.committed then 'America/Santiago' end,
  null,
  case when m.committed then (q.issued_at at time zone 'America/Santiago')::date end,
  case when m.committed then ((q.valid_until - interval '1 microsecond') at time zone 'America/Santiago')::date end,
  case when m.committed then q.valid_until end,
  case when q.status = 'cancelled' then q.cancelled_at end,
  case when q.status = 'cancelled' then 'legacy_v1' end,
  case when q.status = 'cancelled' then 'legacy-v1' end,
  case when q.status = 'expired' then q.expired_at end,
  'legacy-v1',
  q.created_at,
  q.updated_at
from v1_quotes q
join m_quotes m using (quote_id)
join m_totals t using (quote_id)
join m_customers c using (quote_id);

insert into quote_service.quote_lines (
  line_id, quote_id, position, kind, item_source_system, item_product_ref, item_variant_ref,
  item_sku, item_description, item_attributes, quantity, quantity_unit, unit_amount, tax_basis, tax_rate,
  net_amount, tax_amount, gross_amount
)
select
  l.line_id, l.quote_id, l.position, l.kind, l.item_source_system, l.item_product_ref, l.item_variant_ref,
  l.item_sku, l.item_description, '[]'::jsonb, l.quantity, 'unit', l.unit_amount, l.tax_basis, l.tax_rate,
  l.net, l.tax, l.gross
from m_lines l;

-- One synthetic succeeded operation per formally issued V1 quote.
insert into quote_service.issuance_operations (
  operation_id, quote_id, operation_type, origin, retry_of_operation_id, status, generation,
  lease_owner, lease_expires_at, attempt_count, last_attempt_at, last_error_code, next_attempt_at,
  accepted_at, deadline_at, completed_at, snapshot_hash, snapshot_hash_algorithm, created_at, updated_at
)
select
  md5('quote-v2-legacy-issuance:' || q.quote_id::text)::uuid,
  q.quote_id, 'quote.issue', 'legacy_v1_migration', null, 'succeeded', 0,
  null, null, 0, null, null, null,
  q.issued_at, q.issued_at + interval '24 hours', q.issued_document_generated_at,
  q.issued_content_hash, 'v1-canonical-json', q.issued_at, q.issued_document_generated_at
from v1_quotes q
join m_quotes m using (quote_id)
where m.committed;

-- Manifest for every V1 issued artifact. Bytes are not touched; the V1
-- storage key is kept as the artifact location.
insert into quote_service.quote_documents (
  document_id, quote_id, operation_id, origin, content_type, semantic_snapshot_hash, semantic_hash_algorithm,
  pdf_sha256, byte_length, renderer_version, template_version, generated_at, storage_key, committed_at
)
select
  md5('quote-v2-legacy-document:' || q.quote_id::text)::uuid,
  q.quote_id,
  md5('quote-v2-legacy-issuance:' || q.quote_id::text)::uuid,
  'legacy_v1', 'application/pdf', q.issued_content_hash, 'v1-canonical-json',
  q.issued_pdf_sha256, null, q.issued_render_version, 'v1-legacy',
  q.issued_document_generated_at, q.issued_pdf_storage_key, q.issued_document_generated_at
from v1_quotes q
join m_quotes m using (quote_id)
where m.committed;

-- Audit: every V1 event becomes legacy.v1.event, ordered by event_at then id.
-- accepted_at / paid_at facts without a V1 audit event are added as derived
-- legacy events (provable from the V1 columns; nothing else is invented).
insert into quote_service.quote_audit_events (
  event_id, quote_id, sequence, event_type, occurred_at, principal_id, operation_id,
  correlation_id, idempotency_key_hash, from_status, to_status, data
)
select
  e.event_id,
  e.quote_id,
  row_number() over (partition by e.quote_id order by e.occurred_at, e.event_id),
  'legacy.v1.event',
  e.occurred_at,
  'legacy-v1',
  null,
  case when pg_temp.is_opaque_ref(e.correlation_id) then e.correlation_id end,
  case when e.idempotency_key is not null then encode(digest(e.idempotency_key, 'sha256'), 'hex') end,
  null,
  null,
  e.data
from (
  select a.audit_event_id as event_id, a.quote_id, a.event_at as occurred_at, a.correlation_id, a.idempotency_key,
         jsonb_strip_nulls(jsonb_build_object(
           'action', a.action, 'v1FromStatus', a.from_status, 'v1ToStatus', a.to_status, 'v1AuditEventId', a.audit_event_id
         )) as data
  from v1_audit a
  union all
  select md5('quote-v2-legacy-accepted:' || q.quote_id::text)::uuid, q.quote_id, q.accepted_at, null, null,
         jsonb_build_object('action', 'accepted', 'derivedFrom', 'quotes.accepted_at')
  from v1_quotes q
  where q.accepted_at is not null
    and not exists (select 1 from v1_audit a where a.quote_id = q.quote_id and a.action = 'accepted')
  union all
  select md5('quote-v2-legacy-paid:' || q.quote_id::text)::uuid, q.quote_id, q.paid_at, null, null,
         jsonb_build_object('action', 'paid', 'derivedFrom', 'quotes.paid_at')
  from v1_quotes q
  where q.paid_at is not null
    and not exists (select 1 from v1_audit a where a.quote_id = q.quote_id and a.action = 'paid')
) e;

-- Deliveries: sent -> sent, failed -> failed, processing -> unknown (outcome
-- ambiguous), pending -> failed with superseded_by_v2_migration so nothing
-- queued in V1 is ever sent after cutover. Outbox rows are not migrated.
insert into quote_service.quote_deliveries (
  delivery_id, quote_id, origin, channel, status, recipient_email, recipient_name, recipient_masked,
  document_sha256, requested_by_principal_id, generation, lease_owner, lease_expires_at, attempt_count,
  last_attempt_at, last_error_code, next_attempt_at, provider_message_id, requested_at, sent_at, updated_at
)
select
  d.delivery_id,
  d.quote_id,
  'legacy_v1',
  'email',
  case d.status when 'sent' then 'sent' when 'failed' then 'failed' when 'processing' then 'unknown' else 'failed' end,
  d.recipient,
  null,
  case
    when position('@' in d.recipient) > 1
      then left(split_part(d.recipient, '@', 1), 2) || '***@' || split_part(d.recipient, '@', 2)
    else '***'
  end,
  q.issued_pdf_sha256,
  'legacy-v1',
  0, null, null,
  d.attempt_count,
  coalesce(d.sent_at, d.failed_at, d.processing_at),
  case d.status
    when 'pending' then 'superseded_by_v2_migration'
    when 'failed' then case when d.failure_code ~ '^[a-z][a-z0-9_]{1,63}$' then d.failure_code else 'legacy_v1_delivery_failed' end
  end,
  null,
  d.provider_message_id,
  d.created_at,
  case when d.status = 'sent' then d.sent_at end,
  greatest(d.created_at, d.processing_at, d.sent_at, d.failed_at)
from v1_deliveries d
join v1_quotes q using (quote_id);

-- Idempotency: completed V1 bindings become typed legacy bindings. Raw keys
-- and response snapshots are not migrated; in_progress/failed rows bound
-- nothing durable and are dropped (frozen mapping §1.3).
insert into quote_service.idempotency_bindings (
  principal_id, operation, key_hash, binding_kind, request_fingerprint, fingerprint_algorithm,
  request_snapshot, resource_type, quote_id, operation_id, delivery_id, bound_at
)
select
  'legacy-v1',
  'legacy.v1.' || k.operation_name,
  encode(digest(k.idempotency_key, 'sha256'), 'hex'),
  'legacy_v1',
  k.request_hash,
  'v1-request-hash',
  null,
  case when k.resource_type = 'quote_delivery' then 'delivery' else 'quote' end,
  case when k.resource_type = 'quote_delivery' then d.quote_id else k.resource_id end,
  null,
  case when k.resource_type = 'quote_delivery' then k.resource_id end,
  k.updated_at
from v1_idempotency k
left join v1_deliveries d on k.resource_type = 'quote_delivery' and d.delivery_id = k.resource_id
where k.status = 'completed';

-- Legacy evidence per quote: the full V1 rows (minus raw idempotency keys),
-- plus the named legacy facts of the frozen mapping.
insert into quote_service.quote_legacy_v1 (quote_id, migrated_at, data)
select
  q.quote_id,
  now(),
  jsonb_build_object(
    'source', 'quote-service-v1@000005_quote_line_shipping',
    'legacy', jsonb_strip_nulls(jsonb_build_object(
      'v1Status', q.status,
      'v1QuoteNumber', case when not m.committed then q.quote_number end,
      'opportunityId', q.opportunity_id,
      'conversationId', q.conversation_id,
      'sourceSystem', q.source_system,
      'sourceCorrelationId', q.source_correlation_id,
      'actor', jsonb_build_object('type', q.actor_type, 'id', q.actor_id),
      'acceptedAt', q.accepted_at,
      'paidAt', q.paid_at,
      'validUntil', q.valid_until,
      'revision', jsonb_strip_nulls(jsonb_build_object(
        'revisionRootId', q.revision_root_id,
        'previousRevisionId', q.previous_revision_id,
        'supersedesQuoteId', q.supersedes_quote_id,
        'supersededByQuoteId', q.superseded_by_quote_id
      )),
      'hashAlgorithm', case when m.committed then 'v1-canonical-json' end,
      'html', case when q.issued_html_storage_key is not null then jsonb_build_object(
        'storageKey', q.issued_html_storage_key, 'sha256', q.issued_html_sha256
      ) end,
      'invalidCustomerFields', nullif(
        jsonb_strip_nulls(jsonb_build_object(
          'email', case when c.email is not null and not c.email_ok then c.email end,
          'phone', case when c.phone is not null and not c.phone_ok then c.phone end,
          'customerId', case when c.customer_id is not null and not c.customer_ref_ok then c.customer_id end
        )),
        '{}'::jsonb
      ),
      'shippingLineIds', (
        select jsonb_agg(l.line_id order by l.display_order) from v1_lines l
        where l.quote_id = q.quote_id and l.type = 'shipping'
      )
    )),
    'v1', jsonb_build_object(
      'quote', to_jsonb(q),
      'lines', coalesce((
        select jsonb_agg(to_jsonb(l) order by l.display_order) from v1_lines l where l.quote_id = q.quote_id
      ), '[]'::jsonb),
      'auditEvents', coalesce((
        select jsonb_agg(
          (to_jsonb(a) - 'idempotency_key')
          || jsonb_build_object('idempotency_key_sha256', case when a.idempotency_key is not null then encode(digest(a.idempotency_key, 'sha256'), 'hex') end)
          order by a.event_at, a.audit_event_id
        ) from v1_audit a where a.quote_id = q.quote_id
      ), '[]'::jsonb),
      'deliveries', coalesce((
        select jsonb_agg(to_jsonb(d) order by d.created_at, d.delivery_id) from v1_deliveries d where d.quote_id = q.quote_id
      ), '[]'::jsonb)
    )
  )
from v1_quotes q
join m_quotes m using (quote_id)
join m_customers c using (quote_id);

-- =====================================================================
-- 6. Post-conditions
-- =====================================================================
do $$
declare
  failures text[] := array[]::text[];
begin
  if (select count(*) from quote_service.quotes) <> (select count(*) from v1_quotes) then
    failures := failures || 'quote count changed';
  end if;
  if (select count(*) from quote_service.quote_legacy_v1) <> (select count(*) from v1_quotes) then
    failures := failures || 'legacy record count';
  end if;
  if (select count(*) from quote_service.quote_lines) <> (select count(*) from v1_lines) then
    failures := failures || 'line count changed';
  end if;
  if exists (
    select 1 from v1_quotes q join m_quotes m using (quote_id)
    join quote_service.quotes v using (quote_id)
    where m.committed and v.quote_number is distinct from q.quote_number
  ) then
    failures := failures || 'issued quote number not preserved';
  end if;
  if exists (
    select 1 from v1_quotes q join m_quotes m using (quote_id)
    left join quote_service.quote_documents d using (quote_id)
    where m.committed and (d.pdf_sha256 is distinct from q.issued_pdf_sha256 or d.storage_key is distinct from q.issued_pdf_storage_key)
  ) then
    failures := failures || 'issued document not preserved';
  end if;
  if (select count(*) from quote_service.quote_audit_events where data ? 'v1AuditEventId') <> (select count(*) from v1_audit) then
    failures := failures || 'audit events not preserved';
  end if;
  if (select count(*) from quote_service.quote_deliveries) <> (select count(*) from v1_deliveries) then
    failures := failures || 'delivery count changed';
  end if;
  if exists (select 1 from quote_service.quote_deliveries where status in ('pending', 'sending')) then
    failures := failures || 'a migrated delivery could still be sent';
  end if;
  if (select count(*) from quote_service.idempotency_bindings) <> (select count(*) from v1_idempotency where status = 'completed') then
    failures := failures || 'completed idempotency bindings not preserved';
  end if;
  if exists (select 1 from quote_service.quotes where status in ('accepted', 'paid')) then
    failures := failures || 'legacy lifecycle state leaked';
  end if;

  if cardinality(failures) > 0 then
    raise exception 'V1 -> V2 migration post-conditions failed: %', array_to_string(failures, '; ');
  end if;
end $$;

-- =====================================================================
-- 7. Integrity triggers (installed after the data migration)
-- =====================================================================

-- Quote state machine and issued-snapshot immutability at the database level.
create function quote_service.quotes_guard() returns trigger language plpgsql as $f$
begin
  if new.quote_id <> old.quote_id or new.created_at <> old.created_at
     or new.created_by_principal_id <> old.created_by_principal_id then
    raise exception 'quote identity is immutable' using errcode = '55000';
  end if;

  if not (
    (old.status = 'draft' and new.status in ('draft', 'issuing', 'cancelled'))
    or (old.status = 'issuing' and new.status in ('issuing', 'issued', 'cancelled'))
    or (old.status = 'issued' and new.status in ('issued', 'cancelled', 'expired'))
    or (old.status = new.status and old.status in ('expired', 'cancelled'))
  ) then
    raise exception 'invalid quote status transition % -> %', old.status, new.status using errcode = '55000';
  end if;

  if new.version < old.version then
    raise exception 'quote version must not decrease' using errcode = '55000';
  end if;

  -- After issue acceptance the commercial snapshot, number, issuance and
  -- validity are frozen; only the lifecycle may move (and the current
  -- operation, by an operator retry).
  if old.status <> 'draft' and (
    new.quote_number is distinct from old.quote_number
    or new.customer is distinct from old.customer
    or new.source_system is distinct from old.source_system
    or new.external_reference_type is distinct from old.external_reference_type
    or new.external_reference is distinct from old.external_reference
    or new.net_amount <> old.net_amount or new.tax_amount <> old.tax_amount
    or new.gross_amount <> old.gross_amount or new.exempt_net_amount <> old.exempt_net_amount
    or new.issued_at is distinct from old.issued_at
    or new.issuer_profile_id is distinct from old.issuer_profile_id
    or new.validity_source is distinct from old.validity_source
    or new.validity_policy_id is distinct from old.validity_policy_id
    or new.validity_tzdb_version is distinct from old.validity_tzdb_version
    or new.validity_issue_local_date is distinct from old.validity_issue_local_date
    or new.validity_through_local_date is distinct from old.validity_through_local_date
    or new.valid_until_exclusive is distinct from old.valid_until_exclusive
    or new.validity_override_principal_id is distinct from old.validity_override_principal_id
    or new.validity_override_reason_code is distinct from old.validity_override_reason_code
    or new.validity_override_note is distinct from old.validity_override_note
  ) then
    raise exception 'issued quote snapshot is immutable' using errcode = '55000';
  end if;

  return new;
end $f$;

create trigger quotes_guard before update on quote_service.quotes
  for each row execute function quote_service.quotes_guard();
create trigger quotes_no_delete before delete on quote_service.quotes
  for each row execute function quote_service.reject_mutation();

-- issued / expired requires a committed manifest (checked at commit).
create function quote_service.quotes_require_document() returns trigger language plpgsql as $f$
begin
  if new.status in ('issued', 'expired')
     and not exists (select 1 from quote_service.quote_documents d where d.quote_id = new.quote_id) then
    raise exception 'quote % is % without a committed document manifest', new.quote_id, new.status
      using errcode = '23514';
  end if;
  return null;
end $f$;

create constraint trigger quotes_require_document
  after insert or update of status on quote_service.quotes
  deferrable initially deferred
  for each row execute function quote_service.quotes_require_document();

-- Lines and shipping are mutable only while the quote is a draft.
create function quote_service.snapshot_child_guard() returns trigger language plpgsql as $f$
declare
  parent_status text;
begin
  select status into parent_status from quote_service.quotes where quote_id = old.quote_id;

  if parent_status is distinct from 'draft' then
    raise exception '% on %.% is not allowed: quote is %', tg_op, tg_table_schema, tg_table_name, parent_status
      using errcode = '55000';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $f$;

create trigger quote_lines_guard before update or delete on quote_service.quote_lines
  for each row execute function quote_service.snapshot_child_guard();
create trigger quote_shipping_guard before update or delete on quote_service.quote_shipping
  for each row execute function quote_service.snapshot_child_guard();

-- Terminal operations are immutable; fencing generation never decreases.
create function quote_service.issuance_operations_guard() returns trigger language plpgsql as $f$
begin
  if tg_op = 'DELETE' then
    raise exception 'issuance operations are never deleted' using errcode = '55000';
  end if;

  if old.status in ('succeeded', 'failed') then
    raise exception 'issuance operation % is terminal (%)', old.operation_id, old.status using errcode = '55000';
  end if;

  if new.operation_id <> old.operation_id or new.quote_id <> old.quote_id
     or new.operation_type <> old.operation_type or new.origin <> old.origin
     or new.accepted_at <> old.accepted_at or new.deadline_at <> old.deadline_at
     or new.snapshot_hash <> old.snapshot_hash
     or new.retry_of_operation_id is distinct from old.retry_of_operation_id then
    raise exception 'issuance operation identity is immutable' using errcode = '55000';
  end if;

  if new.generation < old.generation or new.attempt_count < old.attempt_count then
    raise exception 'fencing generation and attempt count never decrease' using errcode = '55000';
  end if;

  return new;
end $f$;

create trigger issuance_operations_guard before update or delete on quote_service.issuance_operations
  for each row execute function quote_service.issuance_operations_guard();

-- Manifest is immutable; the only permitted change is recording the verified
-- byte length of a legacy artifact.
create function quote_service.quote_documents_guard() returns trigger language plpgsql as $f$
begin
  if tg_op = 'DELETE' then
    raise exception 'document manifests are never deleted' using errcode = '55000';
  end if;

  -- artifact_ref is a generated column: not yet computed on NEW in a BEFORE
  -- trigger, so it is excluded from the comparison (it derives from pdf_sha256).
  if old.origin = 'legacy_v1' and old.byte_length is null and new.byte_length is not null
     and (to_jsonb(new) - 'byte_length' - 'artifact_ref') = (to_jsonb(old) - 'byte_length' - 'artifact_ref') then
    return new;
  end if;

  raise exception 'document manifest % is immutable', old.document_id using errcode = '55000';
end $f$;

create trigger quote_documents_guard before update or delete on quote_service.quote_documents
  for each row execute function quote_service.quote_documents_guard();

create trigger quote_audit_events_append_only before update or delete on quote_service.quote_audit_events
  for each row execute function quote_service.reject_mutation();
create trigger idempotency_bindings_append_only before update or delete on quote_service.idempotency_bindings
  for each row execute function quote_service.reject_mutation();
create trigger quote_legacy_v1_append_only before update or delete on quote_service.quote_legacy_v1
  for each row execute function quote_service.reject_mutation();
`;

exports.up = (pgm) => {
  pgm.sql(SQL);
};

// Irreversible: the V1 tables are dropped. Recovery is backup -> restore.
exports.down = false;
