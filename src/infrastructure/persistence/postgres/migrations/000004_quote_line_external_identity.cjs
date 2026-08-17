// SALES-AGENT-R1-T1.1: additive, nullable external-identity columns on
// quote_lines. Reuses the existing external_item_id column (added in
// 000002) rather than duplicating it - only external_source/
// external_variant_id are new. Every existing row gets NULL for both
// (default column behavior on ADD COLUMN, no backfill, no data rewrite) -
// historical/legacy lines with no catalog identity remain valid as-is.

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: "quote_service", name: "quote_lines" },
    {
      external_source: {
        type: "text"
      },
      external_variant_id: {
        type: "text"
      }
    }
  );
};

exports.down = (pgm) => {
  pgm.dropColumns(
    { schema: "quote_service", name: "quote_lines" },
    ["external_source", "external_variant_id"]
  );
};
