const QUOTE_STATUS_CHECK = `
  status in ('draft', 'issued', 'accepted', 'paid', 'cancelled', 'expired')
`;

const ACTOR_TYPE_CHECK = `
  actor_type in ('sales_agent', 'operator', 'system', 'service')
`;

const SOURCE_SYSTEM_CHECK = `
  source_system in ('crm_customer_360', 'manual', 'api', 'scheduler')
`;

const LINE_TYPE_CHECK = `
  type in ('product', 'service')
`;

exports.up = (pgm) => {
  pgm.createSequence({ schema: "quote_service", name: "quote_number_seq" }, { ifNotExists: true });

  pgm.createTable(
    { schema: "quote_service", name: "quotes" },
    {
      quote_id: {
        type: "uuid",
        primaryKey: true
      },
      quote_number: {
        type: "text",
        notNull: true
      },
      opportunity_id: {
        type: "text",
        notNull: true
      },
      customer_id: {
        type: "text"
      },
      conversation_id: {
        type: "text"
      },
      actor_type: {
        type: "text",
        notNull: true
      },
      actor_id: {
        type: "text",
        notNull: true
      },
      source_system: {
        type: "text",
        notNull: true
      },
      source_correlation_id: {
        type: "text"
      },
      status: {
        type: "text",
        notNull: true
      },
      currency: {
        type: "text",
        notNull: true
      },
      customer_snapshot: {
        type: "jsonb",
        notNull: true
      },
      subtotal: {
        type: "numeric(20,0)",
        notNull: true
      },
      tax_amount: {
        type: "numeric(20,0)",
        notNull: true
      },
      total: {
        type: "numeric(20,0)",
        notNull: true
      },
      valid_until: {
        type: "timestamptz",
        notNull: true
      },
      version: {
        type: "integer",
        notNull: true
      },
      revision_root_id: {
        type: "uuid",
        notNull: true
      },
      previous_revision_id: {
        type: "uuid"
      },
      supersedes_quote_id: {
        type: "uuid"
      },
      superseded_by_quote_id: {
        type: "uuid"
      },
      issued_content_hash: {
        type: "text"
      },
      issued_render_version: {
        type: "text"
      },
      issued_pdf_storage_key: {
        type: "text"
      },
      issued_pdf_sha256: {
        type: "text"
      },
      issued_html_storage_key: {
        type: "text"
      },
      issued_html_sha256: {
        type: "text"
      },
      issued_document_generated_at: {
        type: "timestamptz"
      },
      created_at: {
        type: "timestamptz",
        notNull: true
      },
      updated_at: {
        type: "timestamptz",
        notNull: true
      },
      issued_at: {
        type: "timestamptz"
      },
      accepted_at: {
        type: "timestamptz"
      },
      paid_at: {
        type: "timestamptz"
      },
      cancelled_at: {
        type: "timestamptz"
      },
      expired_at: {
        type: "timestamptz"
      }
    }
  );

  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_status_check",
    `check (${QUOTE_STATUS_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_actor_type_check",
    `check (${ACTOR_TYPE_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_source_system_check",
    `check (${SOURCE_SYSTEM_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_currency_check",
    "check (currency = 'CLP')"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_version_check",
    "check (version > 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_subtotal_check",
    "check (subtotal >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_tax_amount_check",
    "check (tax_amount >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_total_check",
    "check (total >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_quote_number_unique",
    "unique (quote_number)"
  );

  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_revision_root_fk",
    "foreign key (revision_root_id) references quote_service.quotes(quote_id)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_previous_revision_fk",
    "foreign key (previous_revision_id) references quote_service.quotes(quote_id)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_supersedes_fk",
    "foreign key (supersedes_quote_id) references quote_service.quotes(quote_id)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quotes" },
    "quotes_superseded_by_fk",
    "foreign key (superseded_by_quote_id) references quote_service.quotes(quote_id)"
  );

  pgm.createIndex({ schema: "quote_service", name: "quotes" }, "opportunity_id");
  pgm.createIndex({ schema: "quote_service", name: "quotes" }, "status");
  pgm.createIndex({ schema: "quote_service", name: "quotes" }, "revision_root_id");
  pgm.createIndex({ schema: "quote_service", name: "quotes" }, "valid_until");
  pgm.createIndex(
    { schema: "quote_service", name: "quotes" },
    "supersedes_quote_id",
    {
      unique: true,
      where: "supersedes_quote_id is not null",
      name: "quotes_supersedes_quote_id_unique"
    }
  );

  pgm.createTable(
    { schema: "quote_service", name: "quote_lines" },
    {
      line_id: {
        type: "uuid",
        primaryKey: true
      },
      quote_id: {
        type: "uuid",
        notNull: true,
        references: '"quote_service"."quotes"',
        onDelete: "cascade"
      },
      display_order: {
        type: "integer",
        notNull: true
      },
      type: {
        type: "text",
        notNull: true
      },
      external_item_id: {
        type: "text"
      },
      sku: {
        type: "text"
      },
      description: {
        type: "text",
        notNull: true
      },
      quantity: {
        type: "numeric(20,6)",
        notNull: true
      },
      unit_price: {
        type: "numeric(20,0)",
        notNull: true
      },
      tax_included: {
        type: "boolean",
        notNull: true
      },
      tax_rate: {
        type: "numeric(20,6)",
        notNull: true
      },
      line_subtotal: {
        type: "numeric(20,0)",
        notNull: true
      },
      line_tax: {
        type: "numeric(20,0)",
        notNull: true
      },
      line_total: {
        type: "numeric(20,0)",
        notNull: true
      }
    }
  );

  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_type_check",
    `check (${LINE_TYPE_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_quantity_check",
    "check (quantity > 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_unit_price_check",
    "check (unit_price >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_tax_rate_check",
    "check (tax_rate >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_line_subtotal_check",
    "check (line_subtotal >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_line_tax_check",
    "check (line_tax >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_lines" },
    "quote_lines_line_total_check",
    "check (line_total >= 0)"
  );
  pgm.createIndex(
    { schema: "quote_service", name: "quote_lines" },
    ["quote_id", "display_order"],
    { unique: true, name: "quote_lines_quote_id_display_order_unique" }
  );

  pgm.createTable(
    { schema: "quote_service", name: "idempotency_keys" },
    {
      idempotency_key: {
        type: "text",
        notNull: true
      },
      operation_name: {
        type: "text",
        notNull: true
      },
      resource_type: {
        type: "text"
      },
      resource_id: {
        type: "uuid"
      },
      request_hash: {
        type: "text",
        notNull: true
      },
      status: {
        type: "text",
        notNull: true
      },
      response_code: {
        type: "text"
      },
      response_body_snapshot: {
        type: "jsonb"
      },
      created_at: {
        type: "timestamptz",
        notNull: true
      },
      updated_at: {
        type: "timestamptz",
        notNull: true
      },
      expires_at: {
        type: "timestamptz",
        notNull: true
      }
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "idempotency_keys" },
    "idempotency_keys_pk",
    "primary key (idempotency_key, operation_name)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "idempotency_keys" },
    "idempotency_status_check",
    "check (status in ('in_progress', 'completed', 'failed'))"
  );

  pgm.createTable(
    { schema: "quote_service", name: "quote_audit_events" },
    {
      audit_event_id: {
        type: "uuid",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()")
      },
      quote_id: {
        type: "uuid",
        notNull: true,
        references: '"quote_service"."quotes"'
      },
      quote_number: {
        type: "text",
        notNull: true
      },
      action: {
        type: "text",
        notNull: true
      },
      from_status: {
        type: "text"
      },
      to_status: {
        type: "text"
      },
      actor_type: {
        type: "text",
        notNull: true
      },
      actor_id: {
        type: "text",
        notNull: true
      },
      source_system: {
        type: "text",
        notNull: true
      },
      correlation_id: {
        type: "text"
      },
      idempotency_key: {
        type: "text"
      },
      event_at: {
        type: "timestamptz",
        notNull: true
      },
      payload_snapshot: {
        type: "jsonb",
        notNull: true
      }
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_action_check",
    "check (action in ('draft_created', 'draft_updated', 'issued', 'accepted', 'paid', 'cancelled', 'expired', 'revision_created'))"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_actor_type_check",
    `check (${ACTOR_TYPE_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_source_system_check",
    `check (${SOURCE_SYSTEM_CHECK})`
  );
  pgm.createIndex({ schema: "quote_service", name: "quote_audit_events" }, "quote_id");
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: "quote_service", name: "quote_audit_events" });
  pgm.dropTable({ schema: "quote_service", name: "idempotency_keys" });
  pgm.dropTable({ schema: "quote_service", name: "quote_lines" });
  pgm.dropTable({ schema: "quote_service", name: "quotes" });
  pgm.dropSequence({ schema: "quote_service", name: "quote_number_seq" });
};
