# MS PesasChile Quote Service

Quote Service V1 for PesasChile. `T01`, `T02`, `T03`, and `T04` are implemented in this repository:

- bootstrap, configuration, health, and migrations;
- Quote domain and lifecycle;
- PostgreSQL persistence, audit, idempotency, and optimistic concurrency;
- HTTP application API with auth, validation, canonical DTOs, and real HTTP integration tests.

The governing design remains [docs/quote-service-v1-technical-design.md](/C:/Users/Goli/Pesas%20Chile/MS/MS-pesaschile-quote-service/docs/quote-service-v1-technical-design.md).

## Stack

- Node.js 20
- TypeScript
- Fastify
- Zod
- PostgreSQL via `pg`
- `node-pg-migrate`
- Vitest
- ESLint

## Local Setup

1. Copy `.env.example` to `.env`.
2. Install dependencies with `npm install`.
3. Start PostgreSQL with `npm run db:compose:up`.
4. Run migrations with `npm run db:migrate`.
5. Verify connectivity with `npm run db:check`.
6. Start the server with `npm run dev`.

## Validation Commands

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run verify`

## Authentication

- `GET /health` is public.
- Every `/v1/quotes...` endpoint requires `Authorization: Bearer <SERVICE_AUTH_TOKEN>`.
- Missing token returns `401 missing_authentication`.
- Invalid token returns `401 invalid_authentication`.

Authentication identifies the technical caller only. Business metadata still travels in request bodies as `actor` and `source`.

## HTTP Contract

### Serialization

- Monetary decimals are always strings.
- Dates are always ISO-8601 UTC strings.
- `quoteId` and `lineId` are UUID strings.
- `quoteNumber` is a public business identifier.

Example line totals:

```json
{
  "quantity": "2",
  "unitPrice": "4990",
  "taxRate": "0.19",
  "lineSubtotal": "8387",
  "lineTax": "1593",
  "lineTotal": "9980"
}
```

### Error Envelope

```json
{
  "error": {
    "code": "quote_not_found",
    "message": "Quote not found"
  }
}
```

Validation responses may include allowlisted `details.issues[]`. Internal stacks, SQL, secrets, and storage paths are never returned.

### Idempotency

Every mutating endpoint requires `Idempotency-Key`.

- Same key + same logical payload: durable replay of the original result.
- Same key + different payload: `409 idempotency_key_reused_with_different_payload`.
- Request already in progress: `409 idempotency_request_in_progress`.

Idempotency is backed by PostgreSQL from T03. It is not handled in Fastify memory.

### Optimistic Concurrency

Mutations over an existing quote require `expectedVersion` in the JSON body.

- Matching version: command proceeds.
- Stale version: `409 optimistic_concurrency_conflict`.

The API does not auto-retry on behalf of the caller.

## Public Quote DTO

Canonical quote responses include:

- `quoteId`
- `quoteNumber`
- `opportunityId`
- `customerId`
- `conversationId`
- `actor`
- `source`
- `status`
- `currency`
- `customerSnapshot`
- `items[]`
- `pricing`
- `validUntil`
- `version`
- `revision.rootId`
- `revision.previousRevisionId`
- `revision.supersedesQuoteId`
- `revision.supersededByQuoteId`
- `issuedDocument`
- `timestamps`

`issuedDocument` is safe metadata only:

```json
{
  "available": false,
  "contentHash": null,
  "renderVersion": null,
  "generatedAt": null,
  "pdf": {
    "documentRef": null
  },
  "html": {
    "documentRef": null
  }
}
```

No SQL column names, internal filesystem paths, storage keys, or `Decimal` objects are exposed.

## Endpoints

### Health

- `GET /health`

### Quote Commands

- `POST /v1/quotes`
  - Requires `Authorization` and `Idempotency-Key`
  - Creates a draft quote
  - Returns `201`
- `PUT /v1/quotes/:quoteId/draft`
  - Requires `expectedVersion`
  - Replaces mutable draft content
  - Returns `200`
- `POST /v1/quotes/:quoteId/issue`
  - Requires `expectedVersion`
  - Registered now for the final contract
  - Returns `503 document_issuance_unavailable` until T05
- `POST /v1/quotes/:quoteId/accept`
  - Requires `expectedVersion`
  - Returns `200`
- `POST /v1/quotes/:quoteId/mark-paid`
  - Requires `expectedVersion`
  - Returns `200`
- `POST /v1/quotes/:quoteId/cancel`
  - Requires `expectedVersion`
  - Returns `200`
- `POST /v1/quotes/:quoteId/expire`
  - Requires `expectedVersion`
  - `actor.type` must be `system` or `service`
  - Returns `200`
- `POST /v1/quotes/:quoteId/revisions`
  - Requires `expectedVersion`
  - Creates a new draft revision with a new `quoteId`, `quoteNumber`, and line IDs
  - Returns `201`

### Quote Queries

- `GET /v1/quotes/:quoteId`
- `GET /v1/quotes/by-number/:quoteNumber`
- `GET /v1/quotes`
  - Filters: `opportunityId`, `status`, `revisionRootId`
  - Pagination: `limit` default `50`, max `100`; `offset` default `0`
- `GET /v1/quotes/:quoteId/documents`
- `GET /v1/quotes/:quoteId/audit`
  - Pagination: `limit` default `50`, max `100`; `offset` default `0`

List responses are:

```json
{
  "items": [],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "count": 0
  }
}
```

## Request Shapes

### Create Draft Quote

`POST /v1/quotes`

```json
{
  "opportunityId": "opp-123",
  "customerId": "customer-123",
  "conversationId": "conversation-123",
  "actor": {
    "type": "sales_agent",
    "id": "agent-1"
  },
  "source": {
    "system": "crm_customer_360",
    "correlationId": "corr-1"
  },
  "currency": "CLP",
  "customerSnapshot": {
    "name": "Jane Doe",
    "businessName": "Pesas Chile",
    "email": "jane@example.com",
    "phone": "12345678",
    "address": "Street 1",
    "district": "Santiago",
    "region": "RM"
  },
  "items": [
    {
      "type": "product",
      "externalItemId": "sku-1",
      "sku": "SKU-1",
      "description": "Line 1",
      "quantity": "2",
      "unitPrice": "4990",
      "taxIncluded": true,
      "taxRate": "0.19"
    }
  ],
  "validUntil": "2026-08-20T00:00:00.000Z"
}
```

Caller-controlled fields do not include `quoteId`, `quoteNumber`, `lineId`, pricing totals, timestamps, status, or revision metadata.

### Update Draft

`PUT /v1/quotes/:quoteId/draft`

```json
{
  "expectedVersion": 1,
  "actor": {
    "type": "sales_agent",
    "id": "agent-1"
  },
  "source": {
    "system": "crm_customer_360",
    "correlationId": "corr-2"
  },
  "customerSnapshot": {
    "name": "Jane Doe"
  },
  "items": [
    {
      "type": "product",
      "description": "Updated line",
      "quantity": "1",
      "unitPrice": "1000",
      "taxIncluded": false,
      "taxRate": "0.19"
    }
  ],
  "validUntil": "2026-08-22T00:00:00.000Z"
}
```

### Lifecycle Commands

`POST /accept`, `POST /mark-paid`, `POST /cancel`, and `POST /issue` share:

```json
{
  "expectedVersion": 2,
  "actor": {
    "type": "operator",
    "id": "operator-1"
  },
  "source": {
    "system": "manual",
    "correlationId": "corr-3"
  }
}
```

`POST /expire` uses the same contract but restricts `actor.type` to `system | service`.

### Create Revision

`POST /v1/quotes/:quoteId/revisions`

```json
{
  "expectedVersion": 2,
  "actor": {
    "type": "operator",
    "id": "operator-1"
  },
  "source": {
    "system": "manual",
    "correlationId": "corr-4"
  },
  "newValidUntil": "2026-08-25T00:00:00.000Z"
}
```

## Main Error Codes

### `400`

- `invalid_quote_reference`
- `invalid_quote_number`
- `invalid_customer_snapshot`
- `invalid_actor`
- `invalid_source`
- `invalid_currency`
- `invalid_line_quantity`
- `invalid_line_price`
- `invalid_tax_rate`
- `invalid_valid_until`
- `validation_error`

### `401`

- `missing_authentication`
- `invalid_authentication`

### `404`

- `quote_not_found`

### `409`

- `invalid_quote_status_transition`
- `draft_only_operation`
- `quote_already_terminal`
- `quote_already_superseded`
- `optimistic_concurrency_conflict`
- `idempotency_key_reused_with_different_payload`
- `idempotency_request_in_progress`

### `503`

- `document_issuance_unavailable`

### `500`

- `internal_server_error`

## `/issue` Before T05

T04 intentionally does not fake issued documents.

- The application boundary is already defined through `DocumentIssuancePort`.
- Tests may inject a deterministic fake adapter.
- Productive composition uses a disabled adapter.
- `POST /v1/quotes/:quoteId/issue` returns `503 document_issuance_unavailable`.
- The quote remains `draft`.
- No issued audit event is created.
- No successful idempotency completion is persisted for the failed issuance.

T05 will connect real document rendering and storage without changing the HTTP contract.

## Testing

HTTP integration coverage uses:

- real Fastify server listening on `127.0.0.1:0`;
- real PostgreSQL test databases;
- migrations from zero;
- real `fetch` requests;
- auth, create, read, update, lifecycle, revision, list, audit, idempotency, conflict, and error sanitization scenarios.

This repository also keeps persistence-level integration tests for T03.

## Architecture

Main layers:

- `src/domain`
- `src/application`
- `src/infrastructure`
- `src/http`

The HTTP layer authenticates, validates, builds commands, delegates to application services, maps canonical DTOs, and never performs domain state changes or SQL directly.
