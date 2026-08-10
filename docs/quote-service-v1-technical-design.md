# PesasChile Quote Service V1 - Technical Design

Status: proposed
Date: 2026-08-09
Verdict: READY_TO_IMPLEMENT

## Context

Quote Service V1 will be an external microservice with its own API, persistence, domain model, document generation, idempotency, and audit trail. It is the single source of truth for quotes. It is consumed initially by CRM Customer 360 / AI Sales Agent, but it must not depend on the Sales Agent runtime or CRM storage.

This document intentionally defines the domain first and the HTTP API after that, matching the requested implementation order.

## A. Exact functional scope

In scope for V1:

- Create quote drafts.
- Read existing quotes by canonical identifier and commercial number.
- Update drafts before issuance.
- Calculate line totals and quote totals deterministically.
- Issue a quote.
- Generate an immutable PDF representation for an issued quote.
- Generate an immutable HTML-for-email representation for an issued quote.
- Register acceptance, payment, cancellation, and expiration.
- Enforce lifecycle transitions and command authority at the service boundary.
- Provide durable idempotency for every mutating command.
- Provide durable audit records for every durable state transition and important document events.
- Keep historical customer snapshot data attached to the quote.
- Support restart recovery without losing lifecycle, idempotency, or audit guarantees.

Explicitly out of scope for V1:

- Payment processing.
- Checkout links.
- Email or WhatsApp delivery.
- Catalog integration.
- Shipping calculation.
- Stock reservation.
- Pricing engine.
- Public hosted quote pages.
- Digital signature.
- Multi-level approval.
- ERP/POS/facturation/order creation.

## B. Aggregate and entities

### Aggregate root

`Quote`

Responsibilities:

- Own commercial content and lifecycle.
- Protect mutability rules.
- Own totals as canonical calculated values.
- Own issued document references.
- Own revision lineage metadata.

### Proposed Quote fields

- `quoteId: UUID`
- `quoteNumber: string`
- `opportunityId: string`
- `customerId: string | null`
- `conversationId: string | null`
- `actor: ActorRef`
- `source: SourceRef`
- `status: draft | issued | accepted | paid | cancelled | expired`
- `currency: ISO-4217 string`
- `customerSnapshot: CustomerSnapshot`
- `items: QuoteLine[]`
- `pricing: QuotePricing`
- `validUntil: timestamp with time zone`
- `version: integer`
- `revisionRootId: UUID`
- `previousRevisionId: UUID | null`
- `supersedesQuoteId: UUID | null`
- `supersededByQuoteId: UUID | null`
- `issuedDocument: IssuedDocumentSet | null`
- `timestamps: QuoteTimestamps`

### Entities / value objects

`CustomerSnapshot`

- `name: string`
- `businessName: string | null`
- `email: string | null`
- `phone: string | null`
- `address: string | null`
- `district: string | null`
- `region: string | null`

`ActorRef`

- `type: sales_agent | operator | system | service`
- `id: string`

`SourceRef`

- `system: crm_customer_360 | manual | api | scheduler`
- `correlationId: string | null`

`QuoteLine`

- `lineId: UUID`
- `type: product | service`
- `externalItemId: string | null`
- `sku: string | null`
- `description: string`
- `quantity: decimal`
- `unitPrice: decimal`
- `taxIncluded: boolean`
- `taxRate: decimal`
- `lineSubtotal: decimal`
- `lineTax: decimal`
- `lineTotal: decimal`

`QuotePricing`

- `subtotal: decimal`
- `taxAmount: decimal`
- `total: decimal`

`QuoteTimestamps`

- `createdAt`
- `updatedAt`
- `issuedAt`
- `acceptedAt`
- `paidAt`
- `cancelledAt`
- `expiredAt`

`IssuedDocumentSet`

- `contentHash: string`
- `renderVersion: string`
- `pdfStorageKey: string`
- `pdfSha256: string`
- `htmlStorageKey: string`
- `htmlSha256: string`
- `generatedAt: timestamp with time zone`

Design note:

- `Quote` remains the only transactional aggregate for V1.
- Audit and idempotency are persisted separately but are not separate business aggregates from the API point of view.

## C. Lifecycle and state machine

States:

- `draft`
- `issued`
- `accepted`
- `paid`
- `cancelled`
- `expired`

Allowed transitions:

- `draft -> issued`
- `issued -> accepted`
- `issued -> cancelled`
- `issued -> expired`
- `accepted -> paid`
- `accepted -> cancelled`

Terminal states:

- `paid`
- `cancelled`
- `expired`

State machine rules:

- `draft` is the only mutable content state.
- `issued` freezes all commercial content and totals.
- `accepted` keeps content immutable and means explicit commercial acceptance.
- `paid` means explicit confirmation from an authorized system or operator only.
- In V1, `paid` is a temporary denormalized commercial state used to record externally confirmed payment outcome.
- `paid` must not be treated as a full payment domain model. Partial payments, reversals, retries, and multiple payments are explicitly out of scope for V1.
- `cancelled` means the quote is no longer commercially active.
- `expired` is applied by the service when validity has elapsed and the quote has not reached a terminal commercial outcome.

Expiration strategy:

- Expiration is a command executed by the service, not a virtual computed state.
- V1 should include an internal scheduled job that marks `issued` quotes as `expired` when `validUntil < now()`.
- `accepted` quotes do not auto-expire.

## D. Domain commands

Commands exposed by the application layer:

- `CreateDraftQuote`
- `UpdateDraftQuote`
- `IssueQuote`
- `AcceptQuote`
- `MarkQuotePaid`
- `CancelQuote`
- `ExpireQuote`
- `CreateRevisionFromIssuedQuote`

Command intent:

`CreateDraftQuote`

- Creates a new draft with customer snapshot, items, validity, actor/source metadata, and calculated totals.

`UpdateDraftQuote`

- Replaces mutable draft content.
- Recalculates canonical totals.

`IssueQuote`

- Validates required fields.
- Recalculates totals.
- Builds a canonical issuance snapshot from the draft.
- Generates immutable document representations from that snapshot before the final database transaction.
- Persists immutable issued content and document metadata in one short final transaction.

`AcceptQuote`

- Marks an issued quote as accepted with actor metadata.

`MarkQuotePaid`

- Marks an accepted quote as paid based on external evidence.
- Does not process or authorize payment.

`CancelQuote`

- Cancels an issued or accepted quote.

`ExpireQuote`

- Expires an issued quote after validity has elapsed.

`CreateRevisionFromIssuedQuote`

- Creates a new draft quote derived from an issued quote.
- Links lineage through `revisionRootId` and `previousRevisionId`.
- Does not mutate the original issued quote content.

## E. Invariants

Identity and lineage invariants:

- `quoteId` is immutable and unique.
- `quoteNumber` is immutable after creation and unique.
- `revisionRootId` is immutable.
- A quote may have at most one direct `supersededByQuoteId`.

Content invariants:

- A quote must have at least one line item.
- `currency` is mandatory and immutable after issuance.
- `quantity > 0`.
- `unitPrice >= 0`.
- `taxRate >= 0`.
- `total >= 0`.
- `validUntil > createdAt` at creation time.

Lifecycle invariants:

- Only `draft` may be updated.
- No content mutation is allowed after issuance.
- Only allowed transitions may occur.
- Terminal states reject all further lifecycle mutations.
- `paidAt` can only exist when status is `paid`.
- `acceptedAt` can only exist when status is `accepted` or `paid`.
- `cancelledAt` can only exist when status is `cancelled`.
- `expiredAt` can only exist when status is `expired`.

Document invariants:

- `issuedDocument` is null before issuance.
- `issuedDocument` is mandatory after issuance.
- PDF and HTML hashes must correspond to the same canonical quote snapshot.
- Issued documents are immutable once stored.

Idempotency invariants:

- A successfully completed mutating command with the same idempotency key must return the same durable result.
- A reused idempotency key with a different logical payload must be rejected.

## F. Calculation model

Principles:

- All amounts are calculated inside Quote Service.
- No LLM or template performs calculations.
- PDF, HTML, and API totals come from the same canonical persisted representation.
- The service stores computed line and quote totals explicitly for read consistency and document generation.
- V1 does not support discounts. Discount semantics are deferred until there is an explicit commercial and tax policy.

Per-line calculation:

If `taxIncluded = false`:

- `lineSubtotal = quantity * unitPrice`
- `lineTax = lineSubtotal * taxRate`
- `lineTotal = lineSubtotal + lineTax`

If `taxIncluded = true`:

- `lineTotal = quantity * unitPrice`
- `lineSubtotal = lineTotal / (1 + taxRate)`
- `lineTax = lineTotal - lineSubtotal`

Quote-level calculation:

- `subtotal = sum(lineSubtotal)`
- `taxAmount = sum(lineTax)`
- `total = subtotal + taxAmount`

V1 simplifications:

- No discounts in V1.
- All lines in a quote must use the same currency.
- Rounding policy should be explicit and consistent. Recommendation: decimal arithmetic with half-up rounding to CLP-compatible minor units configured by currency.

## G. Revision strategy

Decision:

- Revisions are modeled as new quotes, not in-place versions of the same `quoteId`.

Reasoning:

- Issued quotes are immutable historical artifacts.
- A new `quoteId` makes audit, delivery, and idempotency simpler.
- Consumers can distinguish the original issued quote from a revised replacement cleanly.

Lineage rules:

- The first quote in a lineage has `revisionRootId = quoteId`.
- Each revision points to `previousRevisionId`.
- If quote B revises quote A, then A gets `supersededByQuoteId = B.quoteId`.
- A superseded quote keeps its original commercial state. Supersession is lineage metadata, not a lifecycle state.

Business effect:

- Consumers should present the latest active quote in a lineage, but historical quotes remain queryable.

## H. Idempotency model

Requirement:

- Every mutating API requires `Idempotency-Key`.

Persistence model:

Table `idempotency_keys` stores:

- `idempotencyKey`
- `operationName`
- `resourceType`
- `resourceId`
- `requestHash`
- `status: in_progress | completed | failed`
- `responseCode`
- `responseBodySnapshot`
- `createdAt`
- `updatedAt`
- `expiresAt`

Behavior:

- On first request, insert key in the same transaction scope as the business mutation where possible.
- If the same key and same request hash are replayed after completion, return stored response.
- If the same key arrives with a different request hash, return `409 idempotency_key_reused_with_different_payload`.
- If the same key is currently in progress, return `409 idempotency_request_in_progress` or block briefly and retry lookup.

Retention:

- Keep idempotency records for at least 30 days in V1.

## I. Audit strategy

Durable audit is required beyond logs.

Table `quote_audit_events` stores:

- `auditEventId: UUID`
- `quoteId: UUID`
- `quoteNumber: string`
- `action: draft_created | draft_updated | issued | accepted | paid | cancelled | expired | revision_created | document_generated`
- `fromStatus: string | null`
- `toStatus: string | null`
- `actorType: sales_agent | operator | system | service`
- `actorId: string`
- `sourceSystem: crm_customer_360 | manual | api | scheduler`
- `correlationId: string | null`
- `idempotencyKey: string | null`
- `eventAt: timestamp with time zone`
- `payloadSnapshot: jsonb`

Rules:

- Every successful mutating command writes an audit event in the same transaction as the business change.
- Document generation during issuance writes either one combined audit record or one issuance record containing document metadata. Recommendation: keep it in the issuance audit payload unless documents can later be regenerated independently.
- Audit records are append-only.

## J. Proposed persistence

Recommended storage:

- PostgreSQL as the primary relational store.
- Object storage for PDF and HTML artifacts. Local filesystem may be used only for development.

Why PostgreSQL:

- Strong transactional guarantees for lifecycle, idempotency, and audit.
- Native support for JSONB snapshots without losing relational constraints where they matter.
- Easy unique constraints and optimistic locking.

Proposed tables:

- `quotes`
- `quote_lines`
- `idempotency_keys`
- `quote_audit_events`

`quotes` should contain:

- quote identity and external references
- status and timestamps
- structured actor/source fields
- customer snapshot as `jsonb`
- pricing snapshot columns
- document metadata columns
- revision lineage columns
- `version` for optimistic concurrency

`quote_lines` should contain:

- `quote_id`
- line identity
- type and item references
- description
- numeric pricing fields
- display order

Key constraints:

- unique `quote_id`
- unique `quote_number`
- unique nullable pair for `idempotencyKey + operationName`
- foreign key `quote_lines.quote_id -> quotes.quote_id`

## K. Proposed API

API style:

- HTTP JSON API, versioned under `/v1`.
- Command-oriented endpoints for lifecycle transitions.
- Query endpoints for retrieval and list/filter operations.

Mutating endpoints:

- `POST /v1/quotes`
- `PUT /v1/quotes/{quoteId}/draft`
- `POST /v1/quotes/{quoteId}/issue`
- `POST /v1/quotes/{quoteId}/accept`
- `POST /v1/quotes/{quoteId}/mark-paid`
- `POST /v1/quotes/{quoteId}/cancel`
- `POST /v1/quotes/{quoteId}/expire`
- `POST /v1/quotes/{quoteId}/revisions`

Read endpoints:

- `GET /v1/quotes/{quoteId}`
- `GET /v1/quotes/by-number/{quoteNumber}`
- `GET /v1/quotes?opportunityId=...&status=...&revisionRootId=...`
- `GET /v1/quotes/{quoteId}/documents`
- `GET /v1/quotes/{quoteId}/audit`

API rules:

- All mutating endpoints require `Idempotency-Key`.
- Authorization details are external to the domain, but the API must receive caller identity and source metadata from the gateway or caller.
- Errors must be domain-specific, not generic 500-first behavior.

Response shape recommendation:

- Return the canonical quote resource with totals, timestamps, revision metadata, and document references.
- Document references should be signed URLs or opaque download tokens, not raw storage paths.

## L. PDF and HTML strategy

Principle:

- Generate both representations from the same canonical issued quote snapshot.
- Avoid holding a long-running SQL transaction open during rendering or object storage upload.

Recommended flow:

1. Read and validate the current `draft` quote state with optimistic concurrency input.
2. Build a canonical issuance snapshot from the draft.
3. Render HTML email from that snapshot.
4. Render printable HTML from the same snapshot.
5. Convert printable HTML to PDF.
6. Hash artifacts and upload them to object storage.
7. Open a short final transaction to revalidate `draft` status and version, then persist `issued` state, document metadata, and audit records.

Important rules:

- Do not compute totals inside templates.
- Do not regenerate content differently for retries with the same issued quote and render version.
- Persist the generated artifacts at issuance time so later retrieval is stable.
- If the final revalidation fails because the draft changed, discard the prepared artifacts and retry with a fresh snapshot.

V1 recommendation:

- Use server-side HTML templates plus a headless browser or HTML-to-PDF renderer.
- Keep a `renderVersion` field so later template changes do not mutate historical documents.

## M. Errors and failure modes

Expected domain errors:

- `quote_not_found`
- `invalid_quote_status_transition`
- `draft_only_operation`
- `quote_already_terminal`
- `quote_expired_not_issued`
- `quote_missing_required_fields_for_issue`
- `quote_has_no_items`
- `invalid_valid_until`
- `invalid_currency`
- `invalid_line_quantity`
- `invalid_line_price`
- `idempotency_key_required`
- `idempotency_key_reused_with_different_payload`
- `idempotency_request_in_progress`
- `document_generation_failed`
- `document_storage_failed`
- `optimistic_concurrency_conflict`

Failure mode handling:

- If document rendering or upload fails before the final issuance transaction, the quote remains `draft`.
- If PDF generation fails after HTML generation but before the final issuance transaction, discard prepared artifacts and keep the quote `draft`.
- The service must not keep a database transaction open while rendering HTML, generating PDF, or uploading artifacts.
- If the final issuance transaction fails optimistic concurrency revalidation, the quote remains `draft` and prepared artifacts are discarded.
- If expiration job races with accept/cancel, rely on optimistic locking and valid transition checks.
- If an external caller retries due to timeout, idempotency returns the prior result.

## N. Required tests

Domain tests:

- Quote creation calculates totals correctly.
- Draft update recalculates totals.
- Invalid transitions are rejected.
- Terminal states reject further transitions.
- Issuance freezes mutable content.
- Revision creation copies required fields and starts a new draft lineage member.

Calculation tests:

- Tax included vs tax excluded lines.
- Mixed product/service lines.
- Rounding edge cases.

Persistence tests:

- Unique `quoteNumber`.
- Audit event written in same transaction as lifecycle change.
- Idempotency replay returns stored response.
- Idempotency key with different payload is rejected.

API tests:

- Validation errors map to expected status codes.
- Mutating endpoints require `Idempotency-Key`.
- Query filters return expected lineage and statuses.

Document tests:

- Issued documents reflect canonical totals.
- Stored document hashes are stable for the same issued payload and render version.

Job tests:

- Expiration job expires only eligible issued quotes.

## O. Explicitly deferred future extensions

- Shipping lines and shipping calculations.
- Service pricing strategies.
- Payment confirmation integration.
- Discount support with explicit tax semantics.
- Hosted quote page.
- Delivery tracking metadata.
- Multi-document variants.
- Partial payments.
- Quote acceptance proof details.
- Catalog references with validation.
- Role/permission policy engine.

## P. Design risks

- `quoteNumber` generation can become a hotspot if it uses a naive sequential allocator. Use a dedicated sequence or allocator table.
- Prepared artifacts can be orphaned if final issuance revalidation fails. V1 should mitigate this with deterministic storage keys and garbage collection of unreferenced artifacts.
- CLP and future multi-currency rounding rules must be explicit early to avoid later document drift.
- Revision lineage can confuse downstream consumers if they treat any non-terminal historical quote as the current active one. API docs must clarify this.
- Large embedded snapshots can bloat the `quotes` table over time. Acceptable in V1, but monitor growth.

## Q. Verdict

`READY_TO_IMPLEMENT`

Rationale:

- The aggregate boundary is clear.
- Lifecycle and invariants are explicit.
- Revisions, idempotency, audit, persistence, and document generation strategies are decided.
- The issuance flow avoids long SQL transactions around rendering and storage.
- Discount ambiguity was removed from V1 instead of being left undefined.
- Actor and source identity are structured from the first version.
- `paid` is explicitly documented as a temporary simplification, not the long-term payment model.
- The design leaves room for future extensions without introducing unnecessary distributed complexity in V1.
