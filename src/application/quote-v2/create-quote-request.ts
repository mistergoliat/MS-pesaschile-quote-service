import { z } from "zod";

/**
 * `CreateQuoteRequest` and its components, transcribed from
 * docs/v2/openapi.yaml. Every object is closed (unknown member → 422).
 * test/unit/create-quote-request.test.ts validates the contract's own
 * examples and negative cases against this schema to catch drift.
 */

// eslint-disable-next-line no-control-regex -- the contract `Text` pattern rejects control characters
const textPattern = /^[^\s\x00-\x1F\x7F](?:[^\x00-\x1F\x7F]*[^\s\x00-\x1F\x7F])?$/;
/** Contract `Text` limited to `max` characters. */
export const text = (max: number) => z.string().min(1).max(max).regex(textPattern);
const systemCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const opaqueReference = z.string().min(1).max(200).regex(/^[!-~](?:[ -~]{0,198}[!-~])?$/);
const quantity = z.string().regex(/^(?:[1-9][0-9]{0,3}(?:\.[0-9]{0,5}[1-9])?|0\.[0-9]{0,5}[1-9])$/);
const taxRate = z.string().regex(/^(?:0\.[0-9]{0,5}[1-9]|1)$/);
const unitAmount = z.number().int().min(0).max(1_000_000_000);
const clpAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const inputInstant = z.iso.datetime({ offset: true });
const localDate = z.iso.date();
const reasonCode = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** Chilean RUT without dots, uppercase K; check digit verified (syntax only). */
export function isValidRut(rut: string): boolean {
  const match = /^([1-9][0-9]{0,7})-([0-9K])$/.exec(rut);

  if (!match) {
    return false;
  }

  let sum = 0;
  let multiplier = 2;

  for (const digit of [...match[1]!].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  return match[2] === (remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder));
}

const rut = z
  .string()
  .regex(/^[1-9][0-9]{0,7}-[0-9K]$/)
  .refine(isValidRut, { params: { code: "invalid_check_digit" }, message: "RUT check digit does not match" });

const chargeAmountInput = z
  .strictObject({
    amount: unitAmount,
    taxBasis: z.enum(["included", "excluded", "exempt"]),
    taxRate: taxRate.optional()
  })
  .superRefine((charge, context) => {
    if (charge.taxBasis === "exempt" && charge.taxRate !== undefined) {
      context.addIssue({ code: "custom", path: ["taxRate"], params: { code: "forbidden" }, message: "taxRate is forbidden for exempt" });
    }

    if (charge.taxBasis !== "exempt" && charge.taxRate === undefined) {
      context.addIssue({ code: "custom", path: ["taxRate"], params: { code: "required" }, message: "taxRate is required unless taxBasis is exempt" });
    }
  });

const address = z
  .strictObject({
    lines: z.array(text(120)).min(1).max(3).optional(),
    commune: text(80).optional(),
    region: text(80).optional(),
    country: z.literal("CL")
  })
  .refine((value) => value.lines !== undefined || value.commune !== undefined, {
    params: { code: "required" },
    message: "address needs lines or commune"
  });

const contact = {
  email: z.email().max(254).optional(),
  phone: z.string().regex(/^\+?[0-9][0-9 ()-]{5,19}$/).optional(),
  address: address.optional(),
  externalCustomerReference: z.strictObject({ sourceSystem: systemCode, reference: opaqueReference }).optional()
};

const customer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("guest"), displayName: text(200).optional(), ...contact }),
  z.strictObject({ kind: z.literal("person"), displayName: text(200), rut: rut.optional(), ...contact }),
  z.strictObject({
    kind: z.literal("company"),
    legalName: text(200),
    tradeName: text(200).optional(),
    rut: rut.optional(),
    contactName: text(200).optional(),
    ...contact
  })
]);

const lineInput = z.strictObject({
  kind: z.enum(["product", "service"]),
  item: z.strictObject({
    sourceSystem: systemCode,
    productRef: opaqueReference.optional(),
    variantRef: opaqueReference.optional(),
    sku: text(100).optional(),
    description: text(300),
    attributes: z.array(z.strictObject({ name: text(60), value: text(120) })).max(10).optional()
  }),
  quantity: z.strictObject({ value: quantity, unit: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/) }),
  unitPrice: chargeAmountInput,
  pricingProvenance: z
    .strictObject({ sourceSystem: systemCode, reference: opaqueReference.optional(), asOf: inputInstant })
    .optional()
});

const shippingInput = z.strictObject({
  carrier: z.strictObject({ code: systemCode.optional(), name: text(120) }),
  serviceType: z
    .strictObject({ code: systemCode.optional(), name: text(120).optional() })
    .refine((value) => Object.keys(value).length > 0, { params: { code: "required" }, message: "serviceType needs code or name" })
    .optional(),
  destination: z.strictObject({ commune: text(80), region: text(80).optional(), country: z.literal("CL") }),
  amount: chargeAmountInput,
  sourceQuote: z.strictObject({ sourceSystem: systemCode, reference: opaqueReference.optional(), asOf: inputInstant }).optional()
});

const externalCorrelation = z
  .strictObject({
    sourceSystem: systemCode,
    externalReferenceType: systemCode.optional(),
    externalReference: opaqueReference.optional()
  })
  .refine((value) => (value.externalReferenceType === undefined) === (value.externalReference === undefined), {
    params: { code: "required" },
    message: "externalReferenceType and externalReference are given together"
  });
const draftLines = z.array(lineInput).max(100);
const expectedTotals = z.strictObject({ net: clpAmount, tax: clpAmount, gross: clpAmount });
const validityOverride = z.strictObject({ validThroughLocalDate: localDate, reasonCode, note: text(500).optional() });
const expectedVersion = z.number().int().min(1);

export const createQuoteRequestSchema = z.strictObject({
  externalCorrelation,
  customer,
  lines: draftLines.min(1),
  shipping: shippingInput.optional(),
  expectedTotals: expectedTotals.optional(),
  validityOverride: validityOverride.optional()
});

/** `CreateDraftRequest`: like create-and-issue but zero lines allowed, no totals or validity. */
export const createDraftRequestSchema = z.strictObject({
  externalCorrelation,
  customer,
  lines: draftLines,
  shipping: shippingInput.optional()
});

/** `UpdateDraftRequest`: each present member replaces the stored one; `shipping: null` removes it. */
export const updateDraftRequestSchema = z
  .strictObject({
    expectedVersion,
    externalCorrelation: externalCorrelation.optional(),
    customer: customer.optional(),
    lines: draftLines.optional(),
    shipping: shippingInput.nullable().optional()
  })
  .refine((value) => Object.keys(value).length >= 2, {
    params: { code: "required" },
    message: "at least one member to replace is required"
  });

export const issueDraftRequestSchema = z.strictObject({
  expectedVersion,
  expectedTotals: expectedTotals.optional(),
  validityOverride: validityOverride.optional()
});

/** `CancelRequest`: `note` is kept in the immutable request snapshot only, never on the quote or in audit data. */
export const cancelRequestSchema = z.strictObject({
  expectedVersion,
  reasonCode,
  note: text(500).optional()
});

export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;
export type UpdateDraftRequest = z.infer<typeof updateDraftRequestSchema>;
export type IssueDraftRequest = z.infer<typeof issueDraftRequestSchema>;
export type LineInput = CreateQuoteRequest["lines"][number];
export type ShippingInput = NonNullable<CreateQuoteRequest["shipping"]>;

export interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Contract `validation_error` details: JSON-pointer path, stable code, human message. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue) => {
    const base = `/${issue.path.join("/")}`.replace(/\/$/, "") || "/";

    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: `${base === "/" ? "" : base}/${key}`,
        code: "unknown_member",
        message: "Unknown member"
      }));
    }

    const custom = (issue as { params?: { code?: string } }).params?.code;
    const code =
      custom ??
      (base === "/lines" && issue.code === "too_small"
        ? "lines_required"
        : issue.code === "invalid_type" && issue.message.endsWith("received undefined")
          ? "required"
          : "invalid");
    return [{ path: base, code, message: issue.message }];
  });
}

/** Contract HTTP status of each command rejection code (Domain §12). */
export const REJECTION_STATUS = {
  validation_error: 422,
  arithmetic_mismatch: 422,
  quote_not_found: 404,
  operation_not_found: 404,
  invalid_state_transition: 409,
  version_conflict: 409,
  operation_in_progress: 409,
  delivery_not_found: 404,
  delivery_recipient_missing: 422
} as const;

/** 4xx rejection of a quote command; the transaction rolls back and nothing is bound. */
export class QuoteRequestRejected extends Error {
  override readonly name = "QuoteRequestRejected";

  constructor(
    readonly code: keyof typeof REJECTION_STATUS,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
