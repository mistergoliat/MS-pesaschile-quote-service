import { formatClpMoney, formatQuantityDisplay } from "../../quote/documents/display-formatting";
import type { IssuedCharge, IssuedLine, IssuedShipping, IssuedSnapshot } from "../issued-snapshot";
import { issuerProfile } from "./issuer-profiles";
import { TEMPLATE_V4, TEMPLATE_VERSION } from "./template-v4";

/*
 * IssuedQuoteDocumentModelV2: everything the formal PDF shows, already
 * resolved to display text, built by a pure function from the frozen issued
 * snapshot (R1.5B1) plus the code-owned issuer profile and template v4.
 *
 * No database, no clock, no environment, no external service, and no
 * arithmetic: every amount is a value frozen at acceptance, only formatted
 * here. The model carries no internal id except the public quote number:
 * no quoteId, line ids, externalCorrelation, item references, provenance,
 * idempotency or worker data.
 */

export interface DocumentTextRow {
  readonly text: string;
  readonly strong: boolean;
}

export interface DocumentLine {
  readonly description: string;
  /** SKU and variant attributes, already labelled. */
  readonly details: readonly string[];
  readonly quantity: string;
  readonly unitAmount: string;
  readonly taxBasis: string;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

export interface DocumentShipping {
  readonly rows: readonly string[];
  readonly amount: string;
  readonly taxBasis: string;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

export interface IssuedQuoteDocumentModelV2 {
  readonly templateVersion: string;
  readonly quoteNumber: string;
  /** Frozen issue instant; used only as the PDF CreationDate (determinism). */
  readonly issuedAt: string;
  readonly issueDate: string;
  readonly validityStatement: string;
  readonly currencyLabel: string;
  readonly issuer: {
    readonly legalName: string;
    readonly rows: readonly string[];
    readonly website: string | null;
    readonly logoAssetId: string;
  };
  readonly customer: readonly DocumentTextRow[];
  readonly lines: readonly DocumentLine[];
  /** Null when the quote has no shipping; `shippingAbsent` is then shown. */
  readonly shipping: DocumentShipping | null;
  readonly shippingAbsent: string | null;
  readonly totals: {
    readonly net: string;
    /** Only when the frozen exempt net is non-zero. */
    readonly exemptNet: string | null;
    readonly tax: string;
    readonly gross: string;
  };
  /** The global VAT statement, only when every charge is tax-included. */
  readonly taxStatement: string | null;
}

export class InvalidIssuedSnapshotError extends Error {
  override readonly name = "InvalidIssuedSnapshotError";
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` civil date → `DD/MM/AAAA` by string transformation (never through a Date, so never a UTC shift). */
export function formatCivilDate(value: string): string {
  const match = CIVIL_DATE.exec(value);

  if (!match) {
    throw new InvalidIssuedSnapshotError("civil date is malformed");
  }

  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Canonical decimal rate in (0, 1] → percentage text with a decimal comma ("0.19" → "19", "0.105" → "10,5"); string arithmetic only. */
export function formatRatePercent(rate: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rate);

  if (!match) {
    throw new InvalidIssuedSnapshotError("tax rate is malformed");
  }

  const fraction = (match[2] ?? "").padEnd(2, "0");
  const integer = `${match[1]}${fraction.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const decimals = fraction.slice(2).replace(/0+$/, "");

  return decimals ? `${integer},${decimals}` : integer;
}

const money = (amount: number): string => formatClpMoney(String(amount));

function taxBasisLabel(charge: IssuedCharge): string {
  if (charge.taxBasis === "exempt") {
    return TEMPLATE_V4.taxBasis.exempt();
  }

  if ((charge.taxBasis !== "included" && charge.taxBasis !== "excluded") || charge.taxRate === undefined) {
    throw new InvalidIssuedSnapshotError("charge tax basis is malformed");
  }

  return TEMPLATE_V4.taxBasis[charge.taxBasis](formatRatePercent(charge.taxRate));
}

const text = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

function addressRow(customer: Readonly<Record<string, unknown>>): string | null {
  const address = customer.address;

  if (typeof address !== "object" || address === null) {
    return null;
  }

  const record = address as Record<string, unknown>;
  const lines = Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === "string") : [];
  const country = text(record, "country");
  const parts = [...lines, text(record, "commune"), text(record, "region"), country ? (TEMPLATE_V4.countryNames[country] ?? country) : null];

  return parts.filter((part): part is string => part !== null).join(", ") || null;
}

/** Domain §9.1/§15: the customer snapshot as given; absent fields omitted; nothing fabricated. */
function customerRows(customer: Readonly<Record<string, unknown>>): DocumentTextRow[] {
  const row = (value: string | null, strong = false): DocumentTextRow[] => (value === null ? [] : [{ text: value, strong }]);
  const labelled = (label: string, value: string | null) => (value === null ? null : `${label}: ${value}`);
  const contact = [
    ...row(labelled(TEMPLATE_V4.customerEmailLabel, text(customer, "email"))),
    ...row(labelled(TEMPLATE_V4.customerPhoneLabel, text(customer, "phone"))),
    ...row(addressRow(customer))
  ];

  switch (customer.kind) {
    case "company":
      return [
        ...row(text(customer, "legalName"), true),
        ...row(labelled(TEMPLATE_V4.customerTradeNameLabel, text(customer, "tradeName"))),
        ...row(labelled(TEMPLATE_V4.customerRutLabel, text(customer, "rut"))),
        ...row(labelled(TEMPLATE_V4.customerContactLabel, text(customer, "contactName"))),
        ...contact
      ];
    case "person":
      return [...row(text(customer, "displayName"), true), ...row(labelled(TEMPLATE_V4.customerRutLabel, text(customer, "rut"))), ...contact];
    case "guest": {
      const rows = [...row(text(customer, "displayName"), true), ...contact];
      return rows.length > 0 ? rows : [{ text: TEMPLATE_V4.customerNotInformed, strong: false }];
    }
    default:
      throw new InvalidIssuedSnapshotError("customer kind is not supported");
  }
}

function lineModel(line: IssuedLine): DocumentLine {
  const attributes = (line.item.attributes ?? []).map((attribute) => {
    const record = attribute as Record<string, unknown>;
    const name = text(record, "name");
    const value = text(record, "value");

    if (name === null || value === null) {
      throw new InvalidIssuedSnapshotError("item attribute is malformed");
    }

    return `${name}: ${value}`;
  });
  const unit = TEMPLATE_V4.unitLabels[line.quantity.unit] ?? line.quantity.unit;

  return {
    description: line.item.description,
    details: [...(line.item.sku ? [`${TEMPLATE_V4.skuLabel}: ${line.item.sku}`] : []), ...attributes],
    // Decimal comma: the dot is the CLP thousands separator on the same page ("1,5", never "1.5").
    quantity: `${formatQuantityDisplay(line.quantity.value).replace(".", ",")} ${unit}`,
    unitAmount: money(line.unitPrice.amount),
    taxBasis: taxBasisLabel(line.unitPrice),
    net: money(line.amounts.net),
    tax: money(line.amounts.tax),
    gross: money(line.amounts.gross)
  };
}

function shippingModel(shipping: IssuedShipping): DocumentShipping {
  const destination = [shipping.destination.commune, shipping.destination.region ?? null]
    .filter((part): part is string => part !== null)
    .join(", ");

  return {
    rows: [
      `${TEMPLATE_V4.shippingCarrierLabel}: ${shipping.carrier.name}`,
      ...(shipping.serviceType?.name ? [`${TEMPLATE_V4.shippingServiceLabel}: ${shipping.serviceType.name}`] : []),
      `${TEMPLATE_V4.shippingDestinationLabel}: ${destination}`
    ],
    amount: money(shipping.amount.amount),
    taxBasis: taxBasisLabel(shipping.amount),
    net: money(shipping.amounts.net),
    tax: money(shipping.amounts.tax),
    gross: money(shipping.amounts.gross)
  };
}

/** Pure: frozen issued snapshot → formal document model (template v4). */
export function buildIssuedQuoteDocumentModelV2(snapshot: IssuedSnapshot): IssuedQuoteDocumentModelV2 {
  const issuer = issuerProfile(snapshot.issuerProfileId);

  if (snapshot.currency !== "CLP") {
    throw new InvalidIssuedSnapshotError("currency is not supported");
  }

  if (snapshot.lines.length === 0) {
    throw new InvalidIssuedSnapshotError("an issued quote has at least one line");
  }

  const charges: IssuedCharge[] = [...snapshot.lines.map((line) => line.unitPrice), ...(snapshot.shipping ? [snapshot.shipping.amount] : [])];

  return {
    templateVersion: TEMPLATE_VERSION,
    quoteNumber: snapshot.quoteNumber,
    issuedAt: snapshot.issuedAt,
    issueDate: `${TEMPLATE_V4.issueDateLabel}: ${formatCivilDate(snapshot.validity.issueLocalDate)}`,
    validityStatement: TEMPLATE_V4.validityStatement(formatCivilDate(snapshot.validity.validThroughLocalDate)),
    currencyLabel: TEMPLATE_V4.currencyLabel,
    issuer: {
      legalName: issuer.legalName,
      rows: [
        ...(issuer.rut ? [`${TEMPLATE_V4.issuerRutLabel}: ${issuer.rut}`] : []),
        ...(issuer.address ? [issuer.address] : []),
        ...(issuer.rut === null || issuer.address === null ? [TEMPLATE_V4.issuerPendingNotice] : [])
      ],
      website: issuer.website,
      logoAssetId: issuer.logoAssetId
    },
    customer: customerRows(snapshot.customer),
    lines: [...snapshot.lines].sort((a, b) => a.position - b.position).map(lineModel),
    shipping: snapshot.shipping ? shippingModel(snapshot.shipping) : null,
    shippingAbsent: snapshot.shipping ? null : TEMPLATE_V4.shippingAbsent,
    totals: {
      net: money(snapshot.totals.net),
      exemptNet: snapshot.totals.exemptNet > 0 ? money(snapshot.totals.exemptNet) : null,
      tax: money(snapshot.totals.tax),
      gross: money(snapshot.totals.gross)
    },
    taxStatement: charges.every((charge) => charge.taxBasis === "included") ? TEMPLATE_V4.allIncludedStatement : null
  };
}
