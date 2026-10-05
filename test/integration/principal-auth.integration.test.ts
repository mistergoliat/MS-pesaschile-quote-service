import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext } from "../../src/app";
import {
  idempotencyScope,
  isValidIdempotencyKey
} from "../../src/application/idempotency/idempotency-scope";
import { HttpError } from "../../src/http/errors";
import type { BusinessRouteRegistrar } from "../../src/http/routes";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { PostgresIdempotencyBindingStore } from "../../src/infrastructure/persistence/postgres/idempotency-binding-store";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { buildRuntimeTestEnv } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, TEST_TOKENS, testRegistryDocument } from "../helpers/test-principals";

const TEST_TIMEOUT_MS = 60_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

/**
 * Test-only business routes. They stand in for the V2 routes (R1.5) to
 * exercise the real authentication, scope enforcement and binding scope:
 *   GET  /probe/whoami  (quotes:read)        → the server-resolved principal
 *   POST /probe/drafts  (quotes:draft:write) → draft + idempotency binding in one tx
 */
function probeRoutes(holder: { context?: ApplicationContext }): BusinessRouteRegistrar {
  return (app) => {
    app.get("/probe/whoami", { config: { requiredScope: "quotes:read" } }, (request) => ({
      principalId: request.principal!.principalId,
      principalType: request.principal!.principalType,
      scopes: [...request.principal!.scopes].sort()
    }));

    app.post("/probe/drafts", { config: { requiredScope: "quotes:draft:write" } }, async (request, reply) => {
      const rawKey = request.headers["idempotency-key"];

      if (!isValidIdempotencyKey(rawKey)) {
        throw new HttpError({ statusCode: 400, code: "invalid_request", message: "Idempotency-Key is required" });
      }

      const database = holder.context!.database;
      const store = new PostgresIdempotencyBindingStore(database);
      const scope = idempotencyScope(request.principal!, "quote.draft.create", rawKey);

      const result = await database.withTransaction(async (client) => {
        const bound = await store.find(scope, client);

        if (bound) {
          return { quoteId: bound.quoteId, replay: true };
        }

        const quoteId = crypto.randomUUID();
        await client.query(
          `insert into quote_service.quotes (
             quote_id, status, version, currency, source_system, customer, net_amount, tax_amount, gross_amount,
             exempt_net_amount, created_by_principal_id, created_at, updated_at
           ) values ($1, 'draft', 1, 'CLP', 'probe', '{"kind":"guest"}', 0, 0, 0, 0, $2, now(), now())`,
          [quoteId, request.principal!.principalId]
        );
        await store.insert(client, {
          ...scope,
          requestFingerprint: sha256Hex(JSON.stringify(request.body ?? {})),
          requestSnapshot: request.body ?? {},
          resourceType: "quote",
          quoteId,
          operationId: null,
          deliveryId: null
        });

        return { quoteId, replay: false };
      });

      return reply.code(result.replay ? 200 : 201).send(result);
    });
  };
}

async function startApp(options: { logs?: string[] } = {}) {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());
  await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-auth-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));

  const holder: { context?: ApplicationContext } = {};
  const context = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: database.connectionString,
      storageRoot,
      overrides: { LOG_LEVEL: options.logs ? "trace" : "silent" }
    }),
    {
      businessRoutes: [probeRoutes(holder)],
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {})
    }
  );
  holder.context = context;
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });

  const call = async (
    method: "GET" | "POST",
    pathname: string,
    options: { token?: string | null; authorization?: string; headers?: Record<string, string>; body?: unknown } = {}
  ) => {
    const headers: Record<string, string> = { ...options.headers };

    if (options.authorization !== undefined) {
      headers.Authorization = options.authorization;
    } else if (options.token) {
      headers.Authorization = bearer(options.token);
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  };

  return { context, call };
}

describe("principal authentication and authorization", () => {
  it("A: a valid credential resolves to the expected server-side principal", async () => {
    const { call } = await startApp();

    expect((await call("GET", "/probe/whoami", { token: TEST_TOKENS.sales })).body).toEqual({
      principalId: "sales-integration",
      principalType: "service",
      scopes: ["quotes:create", "quotes:document:read", "quotes:read"]
    });
    expect((await call("GET", "/probe/whoami", { token: TEST_TOKENS.salesRotated })).body).toMatchObject({
      principalId: "sales-integration"
    });
    expect((await call("GET", "/probe/whoami", { token: TEST_TOKENS.backoffice })).body).toMatchObject({
      principalId: "backoffice",
      principalType: "operator"
    });
  }, TEST_TIMEOUT_MS);

  it.each([
    ["no credential", {}],
    ["unknown token", { token: "u".repeat(64) }],
    ["malformed scheme", { authorization: `Token ${TEST_TOKENS.sales}` }],
    ["principal id as credential", { authorization: "Bearer sales-integration" }]
  ])("B: %s → 401 unauthenticated", async (_label, options) => {
    const { call } = await startApp();
    const response = await call("GET", "/probe/whoami", options);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: "unauthenticated", message: "A valid credential is required", requestId: expect.any(String) as string }
    });
  }, TEST_TIMEOUT_MS);

  it("C: a principal lacking the scope → 403 forbidden with requiredScope, and nothing is bound", async () => {
    const { context, call } = await startApp();

    const draft = await call("POST", "/probe/drafts", {
      token: TEST_TOKENS.sales,
      headers: { "Idempotency-Key": "c-key-1" },
      body: {}
    });
    expect(draft.status).toBe(403);
    expect(draft.body).toEqual({
      error: {
        code: "forbidden",
        message: "The authenticated principal lacks the required scope",
        requestId: expect.any(String) as string,
        details: { requiredScope: "quotes:draft:write" }
      }
    });
    expect((await context.database.query(`select count(*)::int as n from quote_service.idempotency_bindings`)).rows).toEqual([{ n: 0 }]);

    const dependencies = await call("GET", "/health/dependencies", { token: TEST_TOKENS.sales });
    expect(dependencies.status).toBe(403);
    expect(dependencies.body).toMatchObject({ error: { details: { requiredScope: "service:health:dependencies" } } });
    expect((await call("GET", "/health/dependencies", { token: TEST_TOKENS.monitoring })).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("D: the same raw Idempotency-Key under two principals creates independent bindings", async () => {
    const { context, call } = await startApp();
    const rawKey = "shared-raw-key-123";

    const backoffice = await call("POST", "/probe/drafts", { token: TEST_TOKENS.backoffice, headers: { "Idempotency-Key": rawKey }, body: {} });
    const supervisor = await call("POST", "/probe/drafts", { token: TEST_TOKENS.supervisor, headers: { "Idempotency-Key": rawKey }, body: {} });

    expect(backoffice.status).toBe(201);
    expect(supervisor.status).toBe(201);
    expect(backoffice.body!.quoteId).not.toBe(supervisor.body!.quoteId);

    // Each principal replays its own binding, never the other's.
    const backofficeReplay = await call("POST", "/probe/drafts", { token: TEST_TOKENS.backoffice, headers: { "Idempotency-Key": rawKey }, body: {} });
    const supervisorReplay = await call("POST", "/probe/drafts", { token: TEST_TOKENS.supervisor, headers: { "Idempotency-Key": rawKey }, body: {} });
    expect(backofficeReplay.body).toEqual({ quoteId: backoffice.body!.quoteId, replay: true });
    expect(supervisorReplay.body).toEqual({ quoteId: supervisor.body!.quoteId, replay: true });

    const bindings = await context.database.query<{ principal_id: string; key_hash: string; created_by: string }>(
      `select b.principal_id, b.key_hash, q.created_by_principal_id as created_by
       from quote_service.idempotency_bindings b join quote_service.quotes q using (quote_id)
       order by b.principal_id`
    );
    expect(bindings.rows).toEqual([
      { principal_id: "backoffice", key_hash: sha256Hex(rawKey), created_by: "backoffice" },
      { principal_id: "supervisor", key_hash: sha256Hex(rawKey), created_by: "supervisor" }
    ]);
    // The raw key is never stored.
    const everything = await context.database.query<{ dump: string }>(
      `select string_agg(to_jsonb(b)::text, ' ') as dump from quote_service.idempotency_bindings b`
    );
    expect(everything.rows[0]!.dump).not.toContain(rawKey);
  }, TEST_TIMEOUT_MS);

  it("H: a request cannot choose or escalate its principal, type or scopes", async () => {
    const { context, call } = await startApp();
    const escalation = {
      principalId: "supervisor",
      principal: { principalId: "system", scopes: ["quotes:draft:write", "quotes:read:any"] },
      scopes: ["quotes:draft:write", "quotes:validity:override", "service:health:dependencies"],
      actor: { type: "operator", id: "backoffice" },
      createdByPrincipalId: "legacy-v1"
    };
    const spoofHeaders = {
      "X-Principal-Id": "supervisor",
      "X-Scopes": "quotes:draft:write",
      "X-Forwarded-User": "backoffice"
    };

    const whoami = await call("GET", `/probe/whoami?principalId=supervisor&scopes=quotes:draft:write`, {
      token: TEST_TOKENS.sales,
      headers: spoofHeaders
    });
    expect(whoami.body).toEqual({
      principalId: "sales-integration",
      principalType: "service",
      scopes: ["quotes:create", "quotes:document:read", "quotes:read"]
    });

    // Claimed scopes in the body grant nothing.
    const draft = await call("POST", "/probe/drafts", {
      token: TEST_TOKENS.sales,
      headers: { ...spoofHeaders, "Idempotency-Key": "h-key-1" },
      body: escalation
    });
    expect(draft.status).toBe(403);
    expect((await call("GET", "/health/dependencies", { token: TEST_TOKENS.sales, headers: spoofHeaders })).status).toBe(403);

    // A permitted principal still binds and owns as itself, whatever the body claims.
    const owned = await call("POST", "/probe/drafts", {
      token: TEST_TOKENS.backoffice,
      headers: { ...spoofHeaders, "Idempotency-Key": "h-key-2" },
      body: escalation
    });
    expect(owned.status).toBe(201);
    expect(
      (
        await context.database.query(
          `select b.principal_id, q.created_by_principal_id from quote_service.idempotency_bindings b join quote_service.quotes q using (quote_id)`
        )
      ).rows
    ).toEqual([{ principal_id: "backoffice", created_by_principal_id: "backoffice" }]);
  }, TEST_TIMEOUT_MS);

  it("G: secrets never appear in logs, error bodies or diagnostics", async () => {
    const logs: string[] = [];
    const { call } = await startApp({ logs });
    const unknownToken = "unknown-token-that-must-not-be-logged-0123456789abcdef";

    const responses = [
      await call("GET", "/probe/whoami", { token: TEST_TOKENS.sales }),
      await call("GET", "/probe/whoami", { token: unknownToken }),
      await call("POST", "/probe/drafts", { token: TEST_TOKENS.sales, headers: { "Idempotency-Key": "g-key" }, body: {} }),
      await call("POST", "/probe/drafts", { token: TEST_TOKENS.backoffice, headers: { "Idempotency-Key": "g-raw-key-secret" }, body: {} }),
      await call("GET", "/health/dependencies", { token: TEST_TOKENS.monitoring }),
      await call("GET", "/health/dependencies", { authorization: `Bearer ${unknownToken}` })
    ];

    const secrets = [
      ...Object.values(TEST_TOKENS),
      ...Object.values(TEST_TOKENS).map(sha256Hex),
      unknownToken,
      "g-raw-key-secret",
      "Bearer "
    ];
    const haystack = `${logs.join("\n")}\n${responses.map((response) => response.text).join("\n")}`;

    expect(logs.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  }, TEST_TIMEOUT_MS);

  it("a business route that declares no scope is refused at startup", async () => {
    const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => database.dispose());
    const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-auth-"));
    cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
    const context = buildApplication(buildRuntimeTestEnv({ databaseUrl: database.connectionString, storageRoot }), {
      principalRegistry: PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(testRegistryDocument()) }),
      businessRoutes: [(app) => app.get("/probe/unprotected", () => ({ open: true }))]
    });
    cleanups.push(async () => {
      await context.app.close().catch(() => undefined);
    });

    await expect(context.app.ready()).rejects.toThrow(/declares no requiredScope/);
  }, TEST_TIMEOUT_MS);
});
