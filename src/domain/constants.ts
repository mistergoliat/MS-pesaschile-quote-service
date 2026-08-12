export const DOMAIN_LIMITS = Object.freeze({
  quote: {
    maxItems: 100,
    maxQuoteNumberLength: 100
  },
  quoteLine: {
    maxDescriptionLength: 500,
    maxSkuLength: 100,
    maxExternalItemIdLength: 200
  },
  customer: {
    maxNameLength: 200,
    maxBusinessNameLength: 200,
    maxEmailLength: 320,
    maxPhoneLength: 100,
    maxAddressLength: 500,
    maxDistrictLength: 200,
    maxRegionLength: 200
  },
  actor: {
    maxActorIdLength: 200
  },
  source: {
    maxCorrelationIdLength: 200
  },
  references: {
    maxReferenceIdLength: 200
  },
  delivery: {
    maxRecipientLength: 320,
    maxProviderMessageIdLength: 500,
    maxFailureCodeLength: 100,
    maxFailureMessageLength: 500
  },
  document: {
    maxRenderVersionLength: 100,
    maxStorageKeyLength: 500,
    maxContentHashLength: 128
  }
});

export const QUOTE_STATUSES = [
  "draft",
  "issued",
  "accepted",
  "paid",
  "cancelled",
  "expired"
] as const;

export const TERMINAL_QUOTE_STATUSES = ["paid", "cancelled", "expired"] as const;

export const QUOTE_LINE_TYPES = ["product", "service"] as const;

export const ACTOR_TYPES = ["sales_agent", "operator", "system", "service"] as const;

export const SOURCE_SYSTEMS = ["crm_customer_360", "manual", "api", "scheduler"] as const;

export const SUPPORTED_CURRENCIES = ["CLP"] as const;

export const QUOTE_DELIVERY_CHANNELS = ["email"] as const;
export const QUOTE_DELIVERY_STATUSES = ["pending", "processing", "sent", "failed"] as const;
