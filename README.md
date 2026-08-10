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
3. Install the PDF browser with `npm run pdf:install-browser`.
4. If Chromium is not auto-discovered in your environment, set `QUOTE_PDF_EXECUTABLE_PATH` to the installed `chrome-headless-shell` executable.
5. Start PostgreSQL with `npm run db:compose:up`.
6. Run migrations with `npm run db:migrate`.
7. Verify connectivity with `npm run db:check`.
8. Start the server with `npm run dev`.

Production does not assume a host-installed browser. The supported V1 strategy is a reproducible runtime image that provisions `chrome-headless-shell` and points `QUOTE_PDF_EXECUTABLE_PATH` at an in-image path.

## Validation Commands

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:unit`
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
    "documentRef": null,
    "sha256": null
  },
  "html": {
    "documentRef": null,
    "sha256": null
  }
}
```

No SQL column names, internal filesystem paths, storage keys, or `Decimal` objects are exposed.

## Endpoints

### Health

- `GET /health`
- `GET /health/ready`

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
  - Performs real document issuance, durable storage, and final state transition to `issued`
  - Returns `200`
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
- `GET /v1/documents/:documentRef`
  - Requires `Authorization`
  - Streams the persisted PDF or printable HTML for an issued quote

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
- `document_not_found`

### `409`

- `invalid_quote_status_transition`
- `draft_only_operation`
- `quote_already_terminal`
- `quote_already_superseded`
- `optimistic_concurrency_conflict`
- `idempotency_key_reused_with_different_payload`
- `idempotency_request_in_progress`

### `503`

- `document_generation_failed`
- `document_storage_failed`

### `500`

- `internal_server_error`

## T05 Document Issuance

`POST /v1/quotes/:quoteId/issue` now performs real issuance with this sequence:

1. Load the current draft and validate `expectedVersion`.
2. Build a canonical immutable issuance snapshot.
3. Render email HTML, printable HTML, and PDF outside SQL transactions.
4. Compute `contentHash`, `htmlSha256`, and `pdfSha256`.
5. Persist artifacts under deterministic storage keys rooted at `QUOTE_DOCUMENT_STORAGE_ROOT`.
6. Open a short SQL transaction, revalidate state/version, persist the issued quote, audit, and idempotency completion, then commit.

Important invariants:

- No SQL transaction stays open during HTML rendering, PDF generation, hashing, or filesystem writes.
- `contentHash` represents the canonical logical snapshot, not the PDF bytes.
- Public `documentRef` values are opaque HMAC-signed tokens. Internal storage keys and filesystem paths are never exposed.
- Historical artifacts are immutable once a quote is issued.

Document downloads:

- `GET /v1/quotes/:quoteId/documents` returns safe document metadata and public refs.
- `GET /v1/documents/:documentRef` streams the persisted artifact with authenticated access, `Content-Type`, `Content-Disposition`, and `X-Document-Sha256`.

Failure behavior:

- Renderer startup/render failures return `503 document_generation_failed`.
- Storage failures return `503 document_storage_failed`.
- In both cases the quote remains `draft`, no `issued` audit event is committed, and the idempotency record is marked failed so a retry can try again.
- Crash-after-storage but before SQL commit is not solved with distributed transactions; those artifacts remain non-visible and are cleaned through `npm run documents:cleanup`.

Operational commands:

- Install the PDF browser: `npm run pdf:install-browser`
- Clean orphaned artifacts: `npm run documents:cleanup`

## T06 Operational Hardening

### Expiration Scheduler

Issued quotes can now expire automatically through an internal scheduler.

- Only quotes in `issued` with `validUntil < now` are selected.
- Expiration uses the domain transition plus transactional persistence and audit.
- Selection is batched and uses `FOR UPDATE SKIP LOCKED` to stay safe under concurrent workers.
- The scheduler starts only after the server is listening and stops during graceful shutdown.

Configuration:

- `QUOTE_EXPIRATION_SCHEDULER_ENABLED`
- `QUOTE_EXPIRATION_INTERVAL_MS`
- `QUOTE_EXPIRATION_BATCH_SIZE`

### Orphan Cleanup

T06 adds an internal cleanup job on top of the manual `npm run documents:cleanup` command.

- Only artifacts older than `QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS` are eligible.
- Referenced issued artifacts are protected.
- Cleanup uses a PostgreSQL advisory lock so only one instance runs the sweep at a time.
- Crash-before-commit artifacts remain invisible to the API and are eventually removable by the cleanup job or the manual command.

Configuration:

- `QUOTE_DOCUMENT_CLEANUP_ENABLED`
- `QUOTE_DOCUMENT_CLEANUP_INTERVAL_MS`
- `QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS`

### Readiness And Startup Validation

`GET /health` remains the basic liveness check. `GET /health/ready` verifies operational readiness:

- lifecycle phase;
- PostgreSQL connectivity;
- document storage writability;
- PDF renderer/browser availability.

Startup now fails fast if the service cannot reach PostgreSQL, write to the configured storage root, or locate a working browser executable for PDF rendering.

### Timeouts And Limits

Server defaults are explicit and configurable:

- `HTTP_BODY_LIMIT_BYTES`
- `HTTP_REQUEST_TIMEOUT_MS`
- `HTTP_CONNECTION_TIMEOUT_MS`
- `HTTP_KEEP_ALIVE_TIMEOUT_MS`
- `APP_SHUTDOWN_TIMEOUT_MS`
- `DB_POOL_MAX`
- `DB_POOL_IDLE_TIMEOUT_MS`
- `DB_POOL_CONNECTION_TIMEOUT_MS`
- `DB_QUERY_TIMEOUT_MS`

Oversized HTTP payloads return `413`.

### Graceful Shutdown

On `SIGINT` or `SIGTERM` the service:

1. marks lifecycle as shutting down;
2. stops background schedulers;
3. waits for Fastify shutdown within `APP_SHUTDOWN_TIMEOUT_MS`;
4. closes the PostgreSQL pool;
5. closes the PDF renderer/browser resources.

There is no forced `process.exit()` on the happy path.

### Production Runtime

This repository now includes a production-oriented `Dockerfile`.

- Base runtime: Node.js 20 on Debian Bookworm slim.
- Browser strategy: `chrome-headless-shell@stable` provisioned inside the image.
- Runtime user: non-root `nodeapp`.
- Persistent artifacts: mount `/var/lib/pesaschile/quote-documents`.
- Healthcheck: `/health/ready`.

Build:

```bash
docker build -t pesaschile-quote-service:local .
```

Run:

```bash
docker run --rm \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/pesaschile_quote_service \
  -e SERVICE_AUTH_TOKEN=replace-with-a-real-token \
  -e QUOTE_DOCUMENT_REF_SECRET=replace-with-a-long-random-secret \
  -v quote_documents:/var/lib/pesaschile/quote-documents \
  pesaschile-quote-service:local
```

### Production Notes

- Run migrations explicitly with `npm run db:migrate`. The server does not auto-migrate on startup.
- Filesystem storage is durable only if backed by a persistent volume.
- Multiple instances that serve document downloads need shared durable storage.
- Email and WhatsApp delivery remain out of scope; T05/T06 only produce and retain the document artifacts.

## Testing

HTTP integration coverage uses:

- real Fastify server listening on `127.0.0.1:0`;
- real PostgreSQL test databases;
- migrations from zero;
- real `fetch` requests;
- auth, create, read, update, lifecycle, revision, list, audit, idempotency, conflict, and error sanitization scenarios;
- real document rendering and storage;
- authenticated PDF/HTML downloads;
- replay and optimistic conflict during issuance;
- restart persistence over the same database and artifact root.

This repository also keeps persistence-level integration tests for T03.

## Architecture

Main layers:

- `src/domain`
- `src/application`
- `src/infrastructure`
- `src/http`

The HTTP layer authenticates, validates, builds commands, delegates to application services, maps canonical DTOs, and never performs domain state changes or SQL directly.
