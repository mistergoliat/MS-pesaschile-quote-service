const LINE_TYPE_CHECK = `
  type in ('product', 'service', 'shipping')
`;

exports.up = (pgm) => {
  pgm.dropConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_type_check",
    {
      ifExists: true
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_type_check",
    `check (${LINE_TYPE_CHECK})`
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_type_check",
    {
      ifExists: true
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_type_check",
    "check (type in ('product', 'service'))"
  );
};
