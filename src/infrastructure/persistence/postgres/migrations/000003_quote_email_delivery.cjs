const DELIVERY_STATUS_CHECK = `
  status in ('pending', 'processing', 'sent', 'failed')
`;

const OUTBOX_STATUS_CHECK = `
  status in ('pending', 'processing', 'completed', 'failed')
`;

const DELIVERY_CHANNEL_CHECK = `
  channel in ('email')
`;

const AUDIT_ACTION_CHECK = `
  action in (
    'draft_created',
    'draft_updated',
    'issued',
    'accepted',
    'paid',
    'cancelled',
    'expired',
    'revision_created',
    'email_delivery_requested',
    'email_delivery_sent',
    'email_delivery_failed',
    'email_delivery_retry_scheduled'
  )
`;

exports.up = (pgm) => {
  pgm.dropConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_action_check",
    {
      ifExists: true
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_action_check",
    `check (${AUDIT_ACTION_CHECK})`
  );

  pgm.createTable(
    { schema: "quote_service", name: "quote_deliveries" },
    {
      delivery_id: {
        type: "uuid",
        primaryKey: true
      },
      quote_id: {
        type: "uuid",
        notNull: true,
        references: '"quote_service"."quotes"',
        onDelete: "cascade"
      },
      channel: {
        type: "text",
        notNull: true
      },
      recipient: {
        type: "text",
        notNull: true
      },
      status: {
        type: "text",
        notNull: true
      },
      attempt_count: {
        type: "integer",
        notNull: true
      },
      provider_message_id: {
        type: "text"
      },
      failure_code: {
        type: "text"
      },
      failure_message: {
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
      created_at: {
        type: "timestamptz",
        notNull: true
      },
      processing_at: {
        type: "timestamptz"
      },
      sent_at: {
        type: "timestamptz"
      },
      failed_at: {
        type: "timestamptz"
      },
      next_attempt_at: {
        type: "timestamptz"
      }
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_deliveries" },
    "quote_deliveries_channel_check",
    `check (${DELIVERY_CHANNEL_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_deliveries" },
    "quote_deliveries_status_check",
    `check (${DELIVERY_STATUS_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_deliveries" },
    "quote_deliveries_attempt_count_check",
    "check (attempt_count >= 0)"
  );
  pgm.createIndex({ schema: "quote_service", name: "quote_deliveries" }, "quote_id");
  pgm.createIndex({ schema: "quote_service", name: "quote_deliveries" }, "status");
  pgm.createIndex({ schema: "quote_service", name: "quote_deliveries" }, "next_attempt_at");
  pgm.createIndex({ schema: "quote_service", name: "quote_deliveries" }, "created_at");

  pgm.createTable(
    { schema: "quote_service", name: "quote_email_outbox" },
    {
      outbox_id: {
        type: "uuid",
        primaryKey: true
      },
      delivery_id: {
        type: "uuid",
        notNull: true,
        references: '"quote_service"."quote_deliveries"',
        onDelete: "cascade"
      },
      quote_id: {
        type: "uuid",
        notNull: true,
        references: '"quote_service"."quotes"',
        onDelete: "cascade"
      },
      status: {
        type: "text",
        notNull: true
      },
      attempt_count: {
        type: "integer",
        notNull: true
      },
      next_attempt_at: {
        type: "timestamptz",
        notNull: true
      },
      locked_at: {
        type: "timestamptz"
      },
      last_error_code: {
        type: "text"
      },
      last_error_message: {
        type: "text"
      },
      created_at: {
        type: "timestamptz",
        notNull: true
      },
      updated_at: {
        type: "timestamptz",
        notNull: true
      }
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_email_outbox" },
    "quote_email_outbox_status_check",
    `check (${OUTBOX_STATUS_CHECK})`
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_email_outbox" },
    "quote_email_outbox_attempt_count_check",
    "check (attempt_count >= 0)"
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_email_outbox" },
    "quote_email_outbox_delivery_unique",
    "unique (delivery_id)"
  );
  pgm.createIndex({ schema: "quote_service", name: "quote_email_outbox" }, "quote_id");
  pgm.createIndex({ schema: "quote_service", name: "quote_email_outbox" }, "status");
  pgm.createIndex({ schema: "quote_service", name: "quote_email_outbox" }, "next_attempt_at");
  pgm.createIndex({ schema: "quote_service", name: "quote_email_outbox" }, "created_at");
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: "quote_service", name: "quote_email_outbox" });
  pgm.dropTable({ schema: "quote_service", name: "quote_deliveries" });

  pgm.dropConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_action_check",
    {
      ifExists: true
    }
  );
  pgm.addConstraint(
    { schema: "quote_service", name: "quote_audit_events" },
    "quote_audit_events_action_check",
    "check (action in ('draft_created', 'draft_updated', 'issued', 'accepted', 'paid', 'cancelled', 'expired', 'revision_created'))"
  );
};
