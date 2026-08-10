import {
  DOMAIN_LIMITS,
  TERMINAL_QUOTE_STATUSES
} from "./constants";
import type { QUOTE_STATUSES } from "./constants";
import { ActorRef, type ActorRefInput, type ActorRefState } from "./actor-ref";
import {
  CustomerSnapshot,
  type CustomerSnapshotInput,
  type CustomerSnapshotState
} from "./customer-snapshot";
import {
  DOMAIN_ERROR_CODES,
  DomainError
} from "./errors";
import {
  IssuedDocumentSet,
  type IssuedDocumentSetInput,
  type IssuedDocumentSetState
} from "./issued-document-set";
import { isSupportedCurrency, type SupportedCurrency } from "./money";
import {
  QuoteLine,
  type QuoteLineInput,
  type QuoteLineState
} from "./quote-line";
import { QuotePricing, type QuotePricingState } from "./quote-pricing";
import { SourceRef, type SourceRefInput, type SourceRefState } from "./source-ref";
import {
  assertPositiveInteger,
  compareTimestamps,
  ensureNonEmptyText,
  normalizeOptionalText,
  parseTimestamp,
  type TimestampInput
} from "./shared";

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteTimestampsState {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly issuedAt: string | null;
  readonly acceptedAt: string | null;
  readonly paidAt: string | null;
  readonly cancelledAt: string | null;
  readonly expiredAt: string | null;
}

export interface QuoteSnapshot {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly opportunityId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly actor: ActorRefState;
  readonly source: SourceRefState;
  readonly status: QuoteStatus;
  readonly currency: SupportedCurrency;
  readonly customerSnapshot: CustomerSnapshotState;
  readonly items: readonly QuoteLineState[];
  readonly pricing: QuotePricingState;
  readonly validUntil: string;
  readonly version: number;
  readonly revisionRootId: string;
  readonly previousRevisionId: string | null;
  readonly supersedesQuoteId: string | null;
  readonly supersededByQuoteId: string | null;
  readonly issuedDocument: IssuedDocumentSetState | null;
  readonly timestamps: QuoteTimestampsState;
}

export interface CreateDraftQuoteInput {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly opportunityId: string;
  readonly customerId?: string | null;
  readonly conversationId?: string | null;
  readonly actor: ActorRefInput;
  readonly source: SourceRefInput;
  readonly currency: SupportedCurrency;
  readonly customerSnapshot: CustomerSnapshotInput;
  readonly items: readonly QuoteLineInput[];
  readonly validUntil: TimestampInput;
  readonly createdAt: TimestampInput;
}

export interface UpdateDraftQuoteInput {
  readonly customerSnapshot: CustomerSnapshotInput;
  readonly items: readonly QuoteLineInput[];
  readonly validUntil: TimestampInput;
  readonly updatedAt: TimestampInput;
  readonly expectedVersion?: number;
}

export interface IssueQuoteInput {
  readonly issuedDocument: IssuedDocumentSetInput;
  readonly issuedAt: TimestampInput;
  readonly expectedVersion?: number;
}

export interface AcceptQuoteInput {
  readonly acceptedAt: TimestampInput;
  readonly expectedVersion?: number;
}

export interface MarkQuotePaidInput {
  readonly paidAt: TimestampInput;
  readonly expectedVersion?: number;
}

export interface CancelQuoteInput {
  readonly cancelledAt: TimestampInput;
  readonly expectedVersion?: number;
}

export interface ExpireQuoteInput {
  readonly now: TimestampInput;
  readonly expectedVersion?: number;
}

export interface CreateRevisionFromIssuedQuoteInput {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly actor: ActorRefInput;
  readonly source: SourceRefInput;
  readonly createdAt: TimestampInput;
  readonly validUntil?: TimestampInput;
}

export interface QuoteSupersessionLink {
  readonly quoteId: string;
  readonly supersededByQuoteId: string;
  readonly currentVersion: number;
  readonly nextVersion: number;
  readonly updatedAt: string;
}

export interface QuoteRevisionResult {
  readonly revision: Quote;
  readonly predecessorLink: QuoteSupersessionLink;
}

interface QuoteState {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly opportunityId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly actor: ActorRef;
  readonly source: SourceRef;
  readonly status: QuoteStatus;
  readonly currency: SupportedCurrency;
  readonly customerSnapshot: CustomerSnapshot;
  readonly items: readonly QuoteLine[];
  readonly pricing: QuotePricing;
  readonly validUntil: string;
  readonly version: number;
  readonly revisionRootId: string;
  readonly previousRevisionId: string | null;
  readonly supersedesQuoteId: string | null;
  readonly supersededByQuoteId: string | null;
  readonly issuedDocument: IssuedDocumentSet | null;
  readonly timestamps: QuoteTimestampsState;
}

function isTerminalStatus(status: QuoteStatus): boolean {
  return (TERMINAL_QUOTE_STATUSES as readonly string[]).includes(status);
}

function validateReference(
  value: string,
  field: string,
  code = DOMAIN_ERROR_CODES.invalidQuoteReference
): string {
  return ensureNonEmptyText(value, {
    field,
    code,
    maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
  });
}

function validateOptionalReference(
  value: string | null | undefined,
  field: string
): string | null {
  return normalizeOptionalText(value, {
    field,
    code: DOMAIN_ERROR_CODES.invalidQuoteReference,
    maxLength: DOMAIN_LIMITS.references.maxReferenceIdLength
  });
}

function validateQuoteNumber(value: string): string {
  return ensureNonEmptyText(value, {
    field: "quoteNumber",
    code: DOMAIN_ERROR_CODES.invalidQuoteNumber,
    maxLength: DOMAIN_LIMITS.quote.maxQuoteNumberLength,
    pattern: /^[A-Za-z0-9._/-]+$/
  });
}

function assertExpectedVersion(currentVersion: number, expectedVersion?: number): void {
  if (expectedVersion == null) {
    return;
  }

  assertPositiveInteger(expectedVersion, {
    field: "expectedVersion",
    code: DOMAIN_ERROR_CODES.optimisticConcurrencyConflict
  });

  if (expectedVersion !== currentVersion) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.optimisticConcurrencyConflict,
      "Quote version does not match expectedVersion",
      {
        expectedVersion,
        currentVersion
      }
    );
  }
}

function assertValidUntilAfter(
  validUntil: string,
  minimumTimestamp: string,
  field = "validUntil"
): void {
  if (compareTimestamps(validUntil, minimumTimestamp) <= 0) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidValidUntil,
      "validUntil must be later than the reference timestamp",
      {
        field,
        validUntil,
        minimumTimestamp
      }
    );
  }
}

function buildQuoteLines(
  currency: SupportedCurrency,
  items: readonly QuoteLineInput[]
): readonly QuoteLine[] {
  if (items.length === 0) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.quoteHasNoItems,
      "Quote must contain at least one line item"
    );
  }

  if (items.length > DOMAIN_LIMITS.quote.maxItems) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.quoteHasNoItems,
      "Quote exceeds the maximum supported number of line items",
      {
        maxItems: DOMAIN_LIMITS.quote.maxItems
      }
    );
  }

  return items.map((item) => QuoteLine.create(item, currency));
}

function validateTimestamps(
  status: QuoteStatus,
  timestamps: QuoteTimestampsState
): void {
  if (compareTimestamps(timestamps.updatedAt, timestamps.createdAt) < 0) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidQuoteReference,
      "updatedAt must not be earlier than createdAt"
    );
  }

  if (status === "draft") {
    if (
      timestamps.issuedAt ||
      timestamps.acceptedAt ||
      timestamps.paidAt ||
      timestamps.cancelledAt ||
      timestamps.expiredAt
    ) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Draft quotes must not have lifecycle terminal timestamps"
      );
    }

    return;
  }

  if (!timestamps.issuedAt) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
      "Non-draft quotes must have issuedAt"
    );
  }

  if (status === "issued") {
    if (
      timestamps.acceptedAt ||
      timestamps.paidAt ||
      timestamps.cancelledAt ||
      timestamps.expiredAt
    ) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Issued quotes must not have later lifecycle timestamps"
      );
    }

    return;
  }

  if (status === "accepted") {
    if (!timestamps.acceptedAt || timestamps.paidAt || timestamps.cancelledAt || timestamps.expiredAt) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Accepted quotes must have acceptedAt only"
      );
    }

    return;
  }

  if (status === "paid") {
    if (!timestamps.acceptedAt || !timestamps.paidAt || timestamps.cancelledAt || timestamps.expiredAt) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Paid quotes must have acceptedAt and paidAt only"
      );
    }

    return;
  }

  if (status === "cancelled") {
    if (!timestamps.cancelledAt || timestamps.paidAt || timestamps.expiredAt) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Cancelled quotes must have cancelledAt and no paidAt/expiredAt"
      );
    }

    return;
  }

  if (status === "expired") {
    if (!timestamps.expiredAt || timestamps.acceptedAt || timestamps.paidAt || timestamps.cancelledAt) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
        "Expired quotes must have expiredAt only"
      );
    }
  }
}

export class Quote {
  readonly #state: QuoteState;

  private constructor(state: QuoteState) {
    validateTimestamps(state.status, state.timestamps);

    if (state.status === "draft" && state.issuedDocument !== null) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidDocumentSet,
        "Draft quotes cannot have issued documents"
      );
    }

    if (state.status !== "draft" && state.issuedDocument === null) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteMissingRequiredFieldsForIssue,
        "Issued lifecycle states require an issued document set"
      );
    }

    if (state.items.length === 0) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteHasNoItems,
        "Quote must contain at least one line item"
      );
    }

    assertPositiveInteger(state.version, {
      field: "version",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    this.#state = state;
  }

  static createDraft(input: CreateDraftQuoteInput): Quote {
    if (!isSupportedCurrency(input.currency)) {
      throw new DomainError(DOMAIN_ERROR_CODES.invalidCurrency, "Unsupported currency", {
        currency: input.currency
      });
    }

    const createdAt = parseTimestamp(input.createdAt, {
      field: "createdAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });
    const validUntil = parseTimestamp(input.validUntil, {
      field: "validUntil",
      code: DOMAIN_ERROR_CODES.invalidValidUntil
    });

    assertValidUntilAfter(validUntil, createdAt);

    const items = buildQuoteLines(input.currency, input.items);
    const pricing = QuotePricing.fromLines(input.currency, items);

    return new Quote({
      quoteId: validateReference(input.quoteId, "quoteId"),
      quoteNumber: validateQuoteNumber(input.quoteNumber),
      opportunityId: validateReference(input.opportunityId, "opportunityId"),
      customerId: validateOptionalReference(input.customerId, "customerId"),
      conversationId: validateOptionalReference(input.conversationId, "conversationId"),
      actor: ActorRef.create(input.actor),
      source: SourceRef.create(input.source),
      status: "draft",
      currency: input.currency,
      customerSnapshot: CustomerSnapshot.create(input.customerSnapshot),
      items,
      pricing,
      validUntil,
      version: 1,
      revisionRootId: validateReference(input.quoteId, "revisionRootId"),
      previousRevisionId: null,
      supersedesQuoteId: null,
      supersededByQuoteId: null,
      issuedDocument: null,
      timestamps: {
        createdAt,
        updatedAt: createdAt,
        issuedAt: null,
        acceptedAt: null,
        paidAt: null,
        cancelledAt: null,
        expiredAt: null
      }
    });
  }

  static rehydrate(input: QuoteSnapshot): Quote {
    if (!isSupportedCurrency(input.currency)) {
      throw new DomainError(DOMAIN_ERROR_CODES.invalidCurrency, "Unsupported currency", {
        currency: input.currency
      });
    }

    const items = input.items.map((item) => QuoteLine.rehydrate(item, input.currency));
    const pricing = QuotePricing.rehydrate(input.currency, input.pricing, items);

    return new Quote({
      quoteId: validateReference(input.quoteId, "quoteId"),
      quoteNumber: validateQuoteNumber(input.quoteNumber),
      opportunityId: validateReference(input.opportunityId, "opportunityId"),
      customerId: validateOptionalReference(input.customerId, "customerId"),
      conversationId: validateOptionalReference(input.conversationId, "conversationId"),
      actor: ActorRef.create(input.actor),
      source: SourceRef.create(input.source),
      status: input.status,
      currency: input.currency,
      customerSnapshot: CustomerSnapshot.create(input.customerSnapshot),
      items,
      pricing,
      validUntil: parseTimestamp(input.validUntil, {
        field: "validUntil",
        code: DOMAIN_ERROR_CODES.invalidValidUntil
      }),
      version: input.version,
      revisionRootId: validateReference(input.revisionRootId, "revisionRootId"),
      previousRevisionId: validateOptionalReference(input.previousRevisionId, "previousRevisionId"),
      supersedesQuoteId: validateOptionalReference(input.supersedesQuoteId, "supersedesQuoteId"),
      supersededByQuoteId: validateOptionalReference(
        input.supersededByQuoteId,
        "supersededByQuoteId"
      ),
      issuedDocument: input.issuedDocument ? IssuedDocumentSet.create(input.issuedDocument) : null,
      timestamps: {
        createdAt: parseTimestamp(input.timestamps.createdAt, {
          field: "createdAt",
          code: DOMAIN_ERROR_CODES.invalidQuoteReference
        }),
        updatedAt: parseTimestamp(input.timestamps.updatedAt, {
          field: "updatedAt",
          code: DOMAIN_ERROR_CODES.invalidQuoteReference
        }),
        issuedAt: input.timestamps.issuedAt
          ? parseTimestamp(input.timestamps.issuedAt, {
              field: "issuedAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteReference
            })
          : null,
        acceptedAt: input.timestamps.acceptedAt
          ? parseTimestamp(input.timestamps.acceptedAt, {
              field: "acceptedAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteReference
            })
          : null,
        paidAt: input.timestamps.paidAt
          ? parseTimestamp(input.timestamps.paidAt, {
              field: "paidAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteReference
            })
          : null,
        cancelledAt: input.timestamps.cancelledAt
          ? parseTimestamp(input.timestamps.cancelledAt, {
              field: "cancelledAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteReference
            })
          : null,
        expiredAt: input.timestamps.expiredAt
          ? parseTimestamp(input.timestamps.expiredAt, {
              field: "expiredAt",
              code: DOMAIN_ERROR_CODES.invalidQuoteReference
            })
          : null
      }
    });
  }

  get quoteId(): string {
    return this.#state.quoteId;
  }

  get quoteNumber(): string {
    return this.#state.quoteNumber;
  }

  get opportunityId(): string {
    return this.#state.opportunityId;
  }

  get customerId(): string | null {
    return this.#state.customerId;
  }

  get conversationId(): string | null {
    return this.#state.conversationId;
  }

  get status(): QuoteStatus {
    return this.#state.status;
  }

  get currency(): SupportedCurrency {
    return this.#state.currency;
  }

  get validUntil(): string {
    return this.#state.validUntil;
  }

  get version(): number {
    return this.#state.version;
  }

  get revisionRootId(): string {
    return this.#state.revisionRootId;
  }

  get previousRevisionId(): string | null {
    return this.#state.previousRevisionId;
  }

  get supersedesQuoteId(): string | null {
    return this.#state.supersedesQuoteId;
  }

  get supersededByQuoteId(): string | null {
    return this.#state.supersededByQuoteId;
  }

  get actor(): ActorRefState {
    return this.#state.actor.toSnapshot();
  }

  get source(): SourceRefState {
    return this.#state.source.toSnapshot();
  }

  get customerSnapshot(): CustomerSnapshotState {
    return this.#state.customerSnapshot.toSnapshot();
  }

  get items(): readonly QuoteLineState[] {
    return this.#state.items.map((item) => item.toSnapshot());
  }

  get pricing(): QuotePricingState {
    return this.#state.pricing.toSnapshot();
  }

  get issuedDocument(): IssuedDocumentSetState | null {
    return this.#state.issuedDocument?.toSnapshot() ?? null;
  }

  get timestamps(): QuoteTimestampsState {
    return {
      ...this.#state.timestamps
    };
  }

  toSnapshot(): QuoteSnapshot {
    return {
      quoteId: this.quoteId,
      quoteNumber: this.quoteNumber,
      opportunityId: this.opportunityId,
      customerId: this.customerId,
      conversationId: this.conversationId,
      actor: this.actor,
      source: this.source,
      status: this.status,
      currency: this.currency,
      customerSnapshot: this.customerSnapshot,
      items: this.items,
      pricing: this.pricing,
      validUntil: this.validUntil,
      version: this.version,
      revisionRootId: this.revisionRootId,
      previousRevisionId: this.previousRevisionId,
      supersedesQuoteId: this.supersedesQuoteId,
      supersededByQuoteId: this.supersededByQuoteId,
      issuedDocument: this.issuedDocument,
      timestamps: this.timestamps
    };
  }

  updateDraft(input: UpdateDraftQuoteInput): Quote {
    this.assertDraftOnlyOperation();
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    const updatedAt = parseTimestamp(input.updatedAt, {
      field: "updatedAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });
    const validUntil = parseTimestamp(input.validUntil, {
      field: "validUntil",
      code: DOMAIN_ERROR_CODES.invalidValidUntil
    });

    assertValidUntilAfter(validUntil, updatedAt);

    const items = buildQuoteLines(this.#state.currency, input.items);

    return new Quote({
      ...this.#state,
      customerSnapshot: CustomerSnapshot.create(input.customerSnapshot),
      items,
      pricing: QuotePricing.fromLines(this.#state.currency, items),
      validUntil,
      version: this.#state.version + 1,
      timestamps: {
        ...this.#state.timestamps,
        updatedAt
      }
    });
  }

  issue(input: IssueQuoteInput): Quote {
    this.assertTransitionAllowed(["draft"], "issued");
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    if (!input.issuedDocument) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteMissingRequiredFieldsForIssue,
        "issuedDocument is required to issue a quote"
      );
    }

    const issuedAt = parseTimestamp(input.issuedAt, {
      field: "issuedAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    assertValidUntilAfter(this.#state.validUntil, issuedAt, "validUntil");

    return new Quote({
      ...this.#state,
      status: "issued",
      version: this.#state.version + 1,
      issuedDocument: IssuedDocumentSet.create(input.issuedDocument),
      timestamps: {
        ...this.#state.timestamps,
        updatedAt: issuedAt,
        issuedAt
      }
    });
  }

  accept(input: AcceptQuoteInput): Quote {
    this.assertTransitionAllowed(["issued"], "accepted");
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    const acceptedAt = parseTimestamp(input.acceptedAt, {
      field: "acceptedAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    return new Quote({
      ...this.#state,
      status: "accepted",
      version: this.#state.version + 1,
      timestamps: {
        ...this.#state.timestamps,
        updatedAt: acceptedAt,
        acceptedAt
      }
    });
  }

  markPaid(input: MarkQuotePaidInput): Quote {
    this.assertTransitionAllowed(["accepted"], "paid");
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    const paidAt = parseTimestamp(input.paidAt, {
      field: "paidAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    return new Quote({
      ...this.#state,
      status: "paid",
      version: this.#state.version + 1,
      timestamps: {
        ...this.#state.timestamps,
        updatedAt: paidAt,
        paidAt
      }
    });
  }

  cancel(input: CancelQuoteInput): Quote {
    this.assertTransitionAllowed(["issued", "accepted"], "cancelled");
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    const cancelledAt = parseTimestamp(input.cancelledAt, {
      field: "cancelledAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    return new Quote({
      ...this.#state,
      status: "cancelled",
      version: this.#state.version + 1,
      timestamps: {
        ...this.#state.timestamps,
        updatedAt: cancelledAt,
        cancelledAt
      }
    });
  }

  expire(input: ExpireQuoteInput): Quote {
    this.assertTransitionAllowed(["issued"], "expired");
    assertExpectedVersion(this.#state.version, input.expectedVersion);

    const now = parseTimestamp(input.now, {
      field: "now",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });

    if (compareTimestamps(this.#state.validUntil, now) >= 0) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidValidUntil,
        "Quote cannot expire before validUntil has elapsed",
        {
          validUntil: this.#state.validUntil,
          now
        }
      );
    }

    return new Quote({
      ...this.#state,
      status: "expired",
      version: this.#state.version + 1,
      timestamps: {
        ...this.#state.timestamps,
        updatedAt: now,
        expiredAt: now
      }
    });
  }

  createRevision(input: CreateRevisionFromIssuedQuoteInput): QuoteRevisionResult {
    this.assertTransitionAllowed(["issued"], "draft");

    if (this.#state.supersededByQuoteId !== null) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteAlreadySuperseded,
        "Quote already points to a successor revision",
        {
          supersededByQuoteId: this.#state.supersededByQuoteId
        }
      );
    }

    const createdAt = parseTimestamp(input.createdAt, {
      field: "createdAt",
      code: DOMAIN_ERROR_CODES.invalidQuoteReference
    });
    const validUntil = parseTimestamp(input.validUntil ?? this.#state.validUntil, {
      field: "validUntil",
      code: DOMAIN_ERROR_CODES.invalidValidUntil
    });

    assertValidUntilAfter(validUntil, createdAt);

    const revisionItems = this.#state.items.map((item) =>
      QuoteLine.create(item.toSnapshot(), this.#state.currency)
    );

    const revision = new Quote({
      quoteId: validateReference(input.quoteId, "quoteId"),
      quoteNumber: validateQuoteNumber(input.quoteNumber),
      opportunityId: this.#state.opportunityId,
      customerId: this.#state.customerId,
      conversationId: this.#state.conversationId,
      actor: ActorRef.create(input.actor),
      source: SourceRef.create(input.source),
      status: "draft",
      currency: this.#state.currency,
      customerSnapshot: CustomerSnapshot.create(this.#state.customerSnapshot.toSnapshot()),
      items: revisionItems,
      pricing: QuotePricing.fromLines(this.#state.currency, revisionItems),
      validUntil,
      version: 1,
      revisionRootId: this.#state.revisionRootId,
      previousRevisionId: this.#state.quoteId,
      supersedesQuoteId: this.#state.quoteId,
      supersededByQuoteId: null,
      issuedDocument: null,
      timestamps: {
        createdAt,
        updatedAt: createdAt,
        issuedAt: null,
        acceptedAt: null,
        paidAt: null,
        cancelledAt: null,
        expiredAt: null
      }
    });

    return {
      revision,
      predecessorLink: {
        quoteId: this.#state.quoteId,
        supersededByQuoteId: revision.quoteId,
        currentVersion: this.#state.version,
        nextVersion: this.#state.version + 1,
        updatedAt: createdAt
      }
    };
  }

  private assertDraftOnlyOperation(): void {
    if (this.#state.status === "draft") {
      return;
    }

    if (isTerminalStatus(this.#state.status)) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteAlreadyTerminal,
        "Quote is already in a terminal state",
        {
          status: this.#state.status
        }
      );
    }

    throw new DomainError(
      DOMAIN_ERROR_CODES.draftOnlyOperation,
      "Operation is only allowed while the quote is a draft",
      {
        status: this.#state.status
      }
    );
  }

  private assertTransitionAllowed(
    allowedFrom: readonly QuoteStatus[],
    targetStatus: QuoteStatus
  ): void {
    if (allowedFrom.includes(this.#state.status)) {
      return;
    }

    if (isTerminalStatus(this.#state.status)) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.quoteAlreadyTerminal,
        "Quote is already in a terminal state",
        {
          status: this.#state.status,
          targetStatus
        }
      );
    }

    throw new DomainError(
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition,
      "Quote status transition is not allowed",
      {
        fromStatus: this.#state.status,
        targetStatus
      }
    );
  }
}
