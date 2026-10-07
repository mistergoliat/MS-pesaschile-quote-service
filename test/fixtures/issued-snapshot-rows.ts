/**
 * Frozen database rows of accepted (`issuing`) quotes, shaped exactly as `pg`
 * returns them (bigint/numeric as text, timestamptz as Date, civil dates cast
 * to text, jsonb parsed). The golden semantic snapshot hashes in
 * issued-snapshot.test.ts were recorded from these rows through the R1.5A
 * read-projection derivation, before the issued snapshot got its own module.
 * Never edit a fixture to make a hash match.
 */

export interface IssuedSnapshotFixture {
  readonly quote: Record<string, unknown>;
  readonly lines: ReadonlyArray<Record<string, unknown>>;
  readonly shipping: Record<string, unknown> | null;
}

const issuedAt = new Date("2026-10-04T18:00:00.123Z");
const validUntilExclusive = new Date("2026-10-10T03:00:00.000Z");

const quoteBase = {
  status: "issuing",
  version: 1,
  currency: "CLP",
  issued_at: issuedAt,
  issuer_profile_id: "pesaschile-cl-v1",
  validity_issuer_zone: "America/Santiago",
  issue_local_date: "2026-10-04",
  through_local_date: "2026-10-09",
  valid_until_exclusive: validUntilExclusive,
  cancelled_at: null,
  cancellation_reason_code: null,
  cancellation_initiated_by: null,
  expired_at: null,
  created_at: issuedAt,
  updated_at: issuedAt
};

const policyValidity = {
  validity_source: "policy",
  validity_policy_id: "cl-retail-5-calendar-days-v1",
  validity_tzdb_version: "2025b",
  validity_override_principal_id: null,
  validity_override_reason_code: null
};

/** T4 shape: person, two catalog lines with attributes and provenance, full shipping block. */
export const DIRECT_CREATE: IssuedSnapshotFixture = {
  quote: {
    ...quoteBase,
    ...policyValidity,
    quote_id: "0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10",
    quote_number: "PC-000137",
    source_system: "sales-integration",
    external_reference_type: "conversation",
    external_reference: "conv-7f3a91c2",
    customer: { kind: "person", displayName: "Camila Rojas", email: "camila.rojas@example.com", phone: "+56 9 1234 5678" },
    net_amount: "123612",
    tax_amount: "23486",
    gross_amount: "147098",
    exempt_net_amount: "0",
    current_operation_id: "a3d9c1e7-5b2f-4a8c-8e1d-6f4b2c9e7d30",
    created_by_principal_id: "sales-integration"
  },
  lines: [
    {
      quote_id: "0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10",
      line_id: "5c0d7f1e-2a3b-4c5d-8e6f-7a8b9c0d1e21",
      position: 1,
      kind: "product",
      item_source_system: "pesaschile-catalog",
      item_product_ref: "1042",
      item_variant_ref: "3317",
      item_sku: "MH-10",
      item_description: "Mancuerna hexagonal 10 kg",
      item_attributes: [{ name: "Peso", value: "10 kg" }],
      quantity: "2.000000",
      quantity_unit: "unit",
      unit: "24990",
      unit_amount: "24990",
      tax_basis: "included",
      tax_rate: "0.190000",
      pricing_source_system: "pesaschile-catalog",
      pricing_reference: "price-engine-v2",
      pricing_as_of: new Date("2026-10-04T17:58:12.000Z"),
      net_amount: "42000",
      tax_amount: "7980",
      gross_amount: "49980"
    },
    {
      quote_id: "0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10",
      line_id: "5c0d7f1e-2a3b-4c5d-8e6f-7a8b9c0d1e22",
      position: 2,
      kind: "product",
      item_source_system: "pesaschile-catalog",
      item_product_ref: "2210",
      item_variant_ref: null,
      item_sku: "BP-200",
      item_description: "Banco plano reforzado",
      item_attributes: [],
      quantity: "1.000000",
      quantity_unit: "unit",
      unit: "89990",
      unit_amount: "89990",
      tax_basis: "included",
      tax_rate: "0.190000",
      pricing_source_system: "pesaschile-catalog",
      pricing_reference: "price-engine-v2",
      pricing_as_of: new Date("2026-10-04T17:58:12.000Z"),
      net_amount: "75622",
      tax_amount: "14368",
      gross_amount: "89990"
    }
  ],
  shipping: {
    quote_id: "0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10",
    carrier_code: "starken",
    carrier_name: "Starken",
    service_type_code: "domicilio",
    service_type_name: "Entrega a domicilio",
    destination_commune: "Ñuñoa",
    destination_region: "Región Metropolitana",
    destination_country: "CL",
    unit: "7128",
    amount: "7128",
    tax_basis: "included",
    tax_rate: "0.190000",
    source_quote_system: "pesaschile-shipping",
    source_quote_reference: "ship-q-88121",
    source_quote_as_of: new Date("2026-10-04T17:59:01.500Z"),
    net_amount: "5990",
    tax_amount: "1138",
    gross_amount: "7128"
  }
};

/** T3 shape: company with address, exempt service + fractional excluded line, validity override, no shipping. */
export const DRAFT_ISSUE: IssuedSnapshotFixture = {
  quote: {
    ...quoteBase,
    validity_source: "override",
    validity_policy_id: null,
    validity_tzdb_version: "2025b",
    validity_override_principal_id: "supervisor",
    validity_override_reason_code: "customer_requested_extension",
    through_local_date: "2026-10-20",
    valid_until_exclusive: new Date("2026-10-21T03:00:00.000Z"),
    version: 2,
    quote_id: "6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
    quote_number: "PC-000138",
    source_system: "backoffice",
    external_reference_type: null,
    external_reference: null,
    customer: {
      kind: "company",
      legalName: "Gimnasios del Sur SpA",
      tradeName: "SurFit",
      rut: "76.543.210-3",
      contactName: "Pedro Soto",
      email: "compras@surfit.example",
      address: { lines: ["Av. Alemania 1234", "Oficina 5"], commune: "Temuco", region: "Araucanía", country: "CL" }
    },
    net_amount: "151500",
    tax_amount: "19285",
    gross_amount: "170785",
    exempt_net_amount: "50000",
    current_operation_id: "7c2d3e4f-5061-4b72-8c83-a4b5c6d7e8f9",
    created_by_principal_id: "backoffice"
  },
  lines: [
    {
      quote_id: "6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
      line_id: "8d3e4f50-6172-4c83-9d94-b5c6d7e8f901",
      position: 1,
      kind: "service",
      item_source_system: "backoffice",
      item_product_ref: null,
      item_variant_ref: null,
      item_sku: null,
      item_description: "Instalación y armado",
      item_attributes: [],
      quantity: "1.000000",
      quantity_unit: "service",
      unit: "50000",
      unit_amount: "50000",
      tax_basis: "exempt",
      tax_rate: null,
      pricing_source_system: null,
      pricing_reference: null,
      pricing_as_of: null,
      net_amount: "50000",
      tax_amount: "0",
      gross_amount: "50000"
    },
    {
      quote_id: "6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
      line_id: "8d3e4f50-6172-4c83-9d94-b5c6d7e8f902",
      position: 2,
      kind: "product",
      item_source_system: "pesaschile-catalog",
      item_product_ref: "9001",
      item_variant_ref: null,
      item_sku: null,
      item_description: "Caucho de piso 1 m²",
      item_attributes: [{ name: "Espesor", value: "15 mm" }, { name: "Color", value: "Negro" }],
      quantity: "1.500000",
      quantity_unit: "m2",
      unit: "67667",
      unit_amount: "67667",
      tax_basis: "excluded",
      tax_rate: "0.190000",
      pricing_source_system: null,
      pricing_reference: null,
      pricing_as_of: null,
      net_amount: "101501",
      tax_amount: "19285",
      gross_amount: "120786"
    }
  ],
  shipping: null
};

/** Guest customer, one line, minimal exempt shipping (no code, service type, region or source quote). */
export const GUEST_MINIMAL_SHIPPING: IssuedSnapshotFixture = {
  quote: {
    ...quoteBase,
    ...policyValidity,
    quote_id: "9e4f5061-7283-4d94-8ea5-c6d7e8f90a12",
    quote_number: "PC-1000000",
    source_system: "storefront",
    external_reference_type: "cart",
    external_reference: "cart-0001",
    customer: { kind: "guest" },
    net_amount: "13412",
    tax_amount: "1588",
    gross_amount: "15000",
    exempt_net_amount: "5000",
    current_operation_id: "af506172-8394-4ea5-9fb6-d7e8f90a1b23",
    created_by_principal_id: "storefront"
  },
  lines: [
    {
      quote_id: "9e4f5061-7283-4d94-8ea5-c6d7e8f90a12",
      line_id: "b0617283-94a5-4fb6-a0c7-e8f90a1b2c34",
      position: 1,
      kind: "product",
      item_source_system: "pesaschile-catalog",
      item_product_ref: "77",
      item_variant_ref: null,
      item_sku: "KB-8",
      item_description: "Kettlebell 8 kg",
      item_attributes: [],
      quantity: "0.250000",
      quantity_unit: "unit",
      unit: "40000",
      unit_amount: "40000",
      tax_basis: "included",
      tax_rate: "0.190000",
      pricing_source_system: "pesaschile-catalog",
      pricing_reference: null,
      pricing_as_of: new Date("2026-10-04T12:00:00.000Z"),
      net_amount: "8403",
      tax_amount: "1597",
      gross_amount: "10000"
    }
  ],
  shipping: {
    quote_id: "9e4f5061-7283-4d94-8ea5-c6d7e8f90a12",
    carrier_code: null,
    carrier_name: "Retiro coordinado",
    service_type_code: null,
    service_type_name: null,
    destination_commune: "Santiago",
    destination_region: null,
    destination_country: "CL",
    unit: "5000",
    amount: "5000",
    tax_basis: "exempt",
    tax_rate: null,
    source_quote_system: null,
    source_quote_reference: null,
    source_quote_as_of: null,
    net_amount: "5000",
    tax_amount: "0",
    gross_amount: "5000"
  }
};

export const ISSUED_SNAPSHOT_FIXTURES = { DIRECT_CREATE, DRAFT_ISSUE, GUEST_MINIMAL_SHIPPING } as const;
