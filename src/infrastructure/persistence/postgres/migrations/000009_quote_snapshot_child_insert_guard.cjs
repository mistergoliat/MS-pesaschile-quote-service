// R1.4 persistence erratum, discovered during R1.5A.3.
//
// 000007 guards UPDATE and DELETE of quote_lines / quote_shipping (only while
// the parent quote is a draft) but not INSERT, so a line or shipping charge
// could be added to a quote whose commercial snapshot is already frozen.
// This forward migration closes that gap; 000007 is never edited.
//
// Invariant: a snapshot child row can be inserted only while its parent quote
// is 'draft' (rejected for issuing, issued, expired, cancelled). The parent
// row is read FOR SHARE, so an insert cannot race past a concurrent
// draft -> issuing transition: it waits for that commit and then sees the new
// status. Existing UPDATE/DELETE guards are unchanged.

const SQL = String.raw`
create function quote_service.snapshot_child_insert_guard() returns trigger language plpgsql as $f$
declare
  parent_status text;
begin
  select status into parent_status from quote_service.quotes where quote_id = new.quote_id for share;

  if parent_status is distinct from 'draft' then
    raise exception 'INSERT on %.% is not allowed: quote is %', tg_table_schema, tg_table_name, parent_status
      using errcode = '55000';
  end if;

  return new;
end $f$;

create trigger quote_lines_insert_guard before insert on quote_service.quote_lines
  for each row execute function quote_service.snapshot_child_insert_guard();
create trigger quote_shipping_insert_guard before insert on quote_service.quote_shipping
  for each row execute function quote_service.snapshot_child_insert_guard();
`;

exports.up = (pgm) => {
  pgm.sql(SQL);
};

exports.down = (pgm) => {
  pgm.sql(String.raw`
    drop trigger quote_shipping_insert_guard on quote_service.quote_shipping;
    drop trigger quote_lines_insert_guard on quote_service.quote_lines;
    drop function quote_service.snapshot_child_insert_guard();
  `);
};
