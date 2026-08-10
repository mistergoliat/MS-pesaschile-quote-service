# MS PesasChile Quote Service

Bootstrap base for Quote Service V1. This increment implements only `T01`:

- Node.js + TypeScript project bootstrap
- Fastify HTTP server
- `/health` endpoint
- validated environment configuration
- PostgreSQL connection layer
- versioned migration runner
- Docker Compose for local PostgreSQL
- automated tests for config, migrations, database health, and HTTP health

Quote domain, lifecycle, idempotency, audit, document generation, and scheduler are intentionally deferred to `T02+`.

## Stack

- Node.js 20
- TypeScript
- Fastify
- Zod
- PostgreSQL via `pg`
- `node-pg-migrate`
- Vitest
- ESLint

## Local setup

1. Copy `.env.example` to `.env`.
2. Install dependencies: `npm install`
3. Start PostgreSQL: `npm run db:compose:up`
4. Run migrations: `npm run db:migrate`
5. Verify database connectivity: `npm run db:check`
6. Start the server: `npm run dev`

## Validation commands

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify`

## HTTP

- `GET /health`

Example response:

```json
{
  "status": "ok",
  "service": "pesaschile-quote-service",
  "version": "0.1.0",
  "timestamp": "2026-08-09T00:00:00.000Z",
  "checks": {
    "database": {
      "status": "up",
      "latencyMs": 12
    }
  }
}
```

## Architecture

The codebase is split into:

- `src/domain`
- `src/application`
- `src/infrastructure`
- `src/http`

T01 keeps the domain almost empty on purpose. The structure exists so T02 can introduce Quote without reworking the bootstrap.
