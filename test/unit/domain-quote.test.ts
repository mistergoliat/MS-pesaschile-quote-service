import { describe, expect, it } from "vitest";

import { DOMAIN_ERROR_CODES, Quote } from "../../src/domain";
import { expectDomainError } from "./domain-test-helpers";

function buildDraft() {
  return Quote.createDraft({
    quoteId: "quote-1",
    quoteNumber: "Q-0001",
    opportunityId: "opp-1",
    customerId: "customer-1",
    conversationId: "conversation-1",
    actor: {
      type: "sales_agent",
      id: "agent-1"
    },
    source: {
      system: "crm_customer_360",
      correlationId: "corr-1"
    },
    currency: "CLP",
    customerSnapshot: {
      name: "Jane Doe",
      businessName: "Pesas Chile",
      email: "jane@example.com",
      phone: "12345678",
      address: "Street 123",
      district: "Santiago",
      region: "RM"
    },
    items: [
      {
        lineId: "line-1",
        type: "product",
        description: "Line 1",
        quantity: "2",
        unitPrice: "1000",
        taxIncluded: false,
        taxRate: "0.19"
      }
    ],
    validUntil: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-10T00:00:00.000Z"
  });
}

function buildIssuedDocument() {
  return {
    contentHash: "content-hash-v1",
    renderVersion: "v1",
    pdfStorageKey: "quotes/q-0001.pdf",
    pdfSha256: "a".repeat(64),
    htmlStorageKey: "quotes/q-0001.html",
    htmlSha256: "b".repeat(64),
    generatedAt: "2026-08-10T03:00:00.000Z"
  };
}

describe("Quote aggregate", () => {
  it("creates a draft with calculated pricing and initial lineage", () => {
    const quote = buildDraft();

    expect(quote.toSnapshot()).toMatchObject({
      status: "draft",
      version: 1,
      revisionRootId: "quote-1",
      previousRevisionId: null,
      supersedesQuoteId: null,
      supersededByQuoteId: null,
      pricing: {
        subtotal: "2000",
        taxAmount: "380",
        total: "2380"
      },
      timestamps: {
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        issuedAt: null
      }
    });
  });

  it("rejects draft creation without items", () => {
    expectDomainError(
      () =>
        Quote.createDraft({
        ...buildDraft().toSnapshot(),
        actor: {
          type: "sales_agent",
          id: "agent-1"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-1"
        },
        customerSnapshot: {
          name: "Jane Doe"
        },
        items: [],
        validUntil: "2026-08-20T00:00:00.000Z",
        createdAt: "2026-08-10T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.quoteHasNoItems
    );
  });

  it("rejects invalid validUntil and invalid currency", () => {
    expectDomainError(
      () =>
        Quote.createDraft({
        quoteId: "quote-1",
        quoteNumber: "Q-0001",
        opportunityId: "opp-1",
        actor: {
          type: "sales_agent",
          id: "agent-1"
        },
        source: {
          system: "crm_customer_360"
        },
        currency: "CLP",
        customerSnapshot: {
          name: "Jane Doe"
        },
        items: [
          {
            lineId: "line-1",
            type: "product",
            description: "Line 1",
            quantity: "1",
            unitPrice: "1000",
            taxIncluded: false,
            taxRate: "0.19"
          }
        ],
        validUntil: "2026-08-09T00:00:00.000Z",
        createdAt: "2026-08-10T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidValidUntil
    );

    expectDomainError(
      () =>
        Quote.createDraft({
        ...buildDraft().toSnapshot(),
        quoteId: "quote-1",
        quoteNumber: "Q-0001",
        opportunityId: "opp-1",
        actor: {
          type: "sales_agent",
          id: "agent-1"
        },
        source: {
          system: "crm_customer_360",
          correlationId: "corr-1"
        },
        currency: "USD" as "CLP",
        customerSnapshot: {
          name: "Jane Doe"
        },
        items: [
          {
            lineId: "line-1",
            type: "product",
            description: "Line 1",
            quantity: "1",
            unitPrice: "1000",
            taxIncluded: false,
            taxRate: "0.19"
          }
        ],
        validUntil: "2026-08-20T00:00:00.000Z",
        createdAt: "2026-08-10T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidCurrency
    );
  });

  it("updates a draft, recalculates pricing, keeps identity and increments version", () => {
    const quote = buildDraft();
    const updated = quote.updateDraft({
      customerSnapshot: {
        name: "Jane Roe"
      },
      items: [
        {
          lineId: "line-1",
          type: "service",
          description: "Updated line",
          quantity: "1",
          unitPrice: "2380",
          taxIncluded: true,
          taxRate: "0.19"
        }
      ],
      validUntil: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      expectedVersion: 1
    });

    expect(updated.quoteId).toBe("quote-1");
    expect(updated.quoteNumber).toBe("Q-0001");
    expect(updated.opportunityId).toBe("opp-1");
    expect(updated.version).toBe(2);
    expect(updated.customerSnapshot.name).toBe("Jane Roe");
    expect(updated.pricing).toEqual({
      subtotal: "2000",
      taxAmount: "380",
      total: "2380"
    });
  });

  it("does not allow editing issued or terminal quotes", () => {
    const issued = buildDraft().issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });

    expectDomainError(
      () =>
        issued.updateDraft({
        customerSnapshot: {
          name: "Nope"
        },
        items: [
          {
            lineId: "line-1",
            type: "product",
            description: "Updated line",
            quantity: "1",
            unitPrice: "1000",
            taxIncluded: false,
            taxRate: "0.19"
          }
        ],
        validUntil: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.draftOnlyOperation
    );

    const paid = issued
      .accept({
        acceptedAt: "2026-08-10T05:00:00.000Z"
      })
      .markPaid({
        paidAt: "2026-08-10T06:00:00.000Z"
      });

    expectDomainError(
      () =>
        paid.updateDraft({
        customerSnapshot: {
          name: "Still nope"
        },
        items: [
          {
            lineId: "line-1",
            type: "product",
            description: "Updated line",
            quantity: "1",
            unitPrice: "1000",
            taxIncluded: false,
            taxRate: "0.19"
          }
        ],
        validUntil: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.quoteAlreadyTerminal
    );
  });

  it("covers lifecycle transitions and invalid transition attempts", () => {
    const draft = buildDraft();
    const issued = draft.issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z",
      expectedVersion: 1
    });
    const accepted = issued.accept({
      acceptedAt: "2026-08-10T05:00:00.000Z",
      expectedVersion: 2
    });
    const paid = accepted.markPaid({
      paidAt: "2026-08-10T06:00:00.000Z",
      expectedVersion: 3
    });

    expect(issued.status).toBe("issued");
    expect(accepted.status).toBe("accepted");
    expect(paid.status).toBe("paid");

    expectDomainError(
      () =>
        draft.accept({
        acceptedAt: "2026-08-10T05:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );

    expectDomainError(
      () =>
        accepted.issue({
        issuedDocument: buildIssuedDocument(),
        issuedAt: "2026-08-10T05:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );

    expectDomainError(
      () =>
        paid.cancel({
        cancelledAt: "2026-08-10T07:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.quoteAlreadyTerminal
    );
  });

  it("requires an issued document and keeps document metadata immutable after issue", () => {
    const draft = buildDraft();

    expectDomainError(
      () =>
        draft.issue({
        issuedDocument: {
          ...buildIssuedDocument(),
          pdfSha256: "bad"
        },
        issuedAt: "2026-08-10T04:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidDocumentSet
    );

    const issued = draft.issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });

    const externalDocument = issued.issuedDocument;

    if (!externalDocument) {
      throw new Error("Expected issuedDocument");
    }

    (externalDocument as unknown as { pdfStorageKey: string }).pdfStorageKey = "tampered";

    expect(issued.issuedDocument?.pdfStorageKey).toBe("quotes/q-0001.pdf");
    expect(issued.timestamps.issuedAt).toBe("2026-08-10T04:00:00.000Z");
  });

  it("allows acceptance only from issued", () => {
    const issued = buildDraft().issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });

    expect(issued.accept({
      acceptedAt: "2026-08-10T05:00:00.000Z"
    }).status).toBe("accepted");

    expectDomainError(
      () =>
        buildDraft().accept({
        acceptedAt: "2026-08-10T05:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );
  });

  it("allows mark paid only from accepted", () => {
    const accepted = buildDraft()
      .issue({
        issuedDocument: buildIssuedDocument(),
        issuedAt: "2026-08-10T04:00:00.000Z"
      })
      .accept({
        acceptedAt: "2026-08-10T05:00:00.000Z"
      });

    expect(accepted.markPaid({
      paidAt: "2026-08-10T06:00:00.000Z"
    }).status).toBe("paid");

    expectDomainError(
      () =>
        buildDraft().markPaid({
        paidAt: "2026-08-10T06:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );
  });

  it("allows cancel from issued and accepted only", () => {
    const issued = buildDraft().issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });
    const accepted = issued.accept({
      acceptedAt: "2026-08-10T05:00:00.000Z"
    });

    expect(issued.cancel({
      cancelledAt: "2026-08-10T06:00:00.000Z"
    }).status).toBe("cancelled");
    expect(accepted.cancel({
      cancelledAt: "2026-08-10T06:30:00.000Z"
    }).status).toBe("cancelled");

    expectDomainError(
      () =>
        buildDraft().cancel({
        cancelledAt: "2026-08-10T06:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );
  });

  it("expires only issued quotes whose validUntil has elapsed", () => {
    const issued = buildDraft().issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });

    expect(issued.expire({
      now: "2026-08-21T00:00:00.000Z"
    }).status).toBe("expired");

    expectDomainError(
      () =>
        issued.expire({
        now: "2026-08-19T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidValidUntil
    );

    const accepted = issued.accept({
      acceptedAt: "2026-08-10T05:00:00.000Z"
    });

    expectDomainError(
      () =>
        accepted.expire({
        now: "2026-08-21T00:00:00.000Z"
        }),
      DOMAIN_ERROR_CODES.invalidQuoteStatusTransition
    );
  });

  it("creates a revision draft and returns explicit predecessor linkage", () => {
    const issued = buildDraft().issue({
      issuedDocument: buildIssuedDocument(),
      issuedAt: "2026-08-10T04:00:00.000Z"
    });

    const result = issued.createRevision({
      quoteId: "quote-2",
      quoteNumber: "Q-0002",
      actor: {
        type: "operator",
        id: "operator-1"
      },
      source: {
        system: "manual",
        correlationId: "corr-2"
      },
      createdAt: "2026-08-12T00:00:00.000Z",
      validUntil: "2026-08-25T00:00:00.000Z"
    });

    expect(result.revision.toSnapshot()).toMatchObject({
      quoteId: "quote-2",
      quoteNumber: "Q-0002",
      status: "draft",
      revisionRootId: "quote-1",
      previousRevisionId: "quote-1",
      supersedesQuoteId: "quote-1",
      supersededByQuoteId: null,
      pricing: issued.pricing
    });

    expect(result.predecessorLink).toEqual({
      quoteId: "quote-1",
      supersededByQuoteId: "quote-2",
      currentVersion: 2,
      nextVersion: 3,
      updatedAt: "2026-08-12T00:00:00.000Z"
    });

    expect(issued.supersededByQuoteId).toBeNull();
    expect(issued.status).toBe("issued");
  });

  it("protects external mutation attempts against items, customer snapshot and pricing", () => {
    const quote = buildDraft();

    const items = quote.items as unknown as Array<Record<string, string>>;
    const customerSnapshot = quote.customerSnapshot as unknown as Record<string, string>;
    const pricing = quote.pricing as unknown as Record<string, string>;

    items.push({
      lineId: "tampered"
    });
    items[0]!.description = "tampered";
    customerSnapshot.name = "tampered";
    pricing.total = "0";

    expect(quote.items).toHaveLength(1);
    expect(quote.items[0]?.description).toBe("Line 1");
    expect(quote.customerSnapshot.name).toBe("Jane Doe");
    expect(quote.pricing.total).toBe("2380");
  });
});
