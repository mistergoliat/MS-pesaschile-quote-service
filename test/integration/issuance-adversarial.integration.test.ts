/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type ApplicationContext, type BuildApplicationOverrides } from "../../src/app";
import { probeFailed, type ProbeOutcome } from "../../src/application/health/dependency-state";
import type { IssuedQuoteDocumentModelV2 } from "../../src/application/quote-v2/document/issued-quote-document-model";
import { DocumentRenderError, type PdfRendererPort } from "../../src/application/quote-v2/document/pdf-renderer-port";
import { NativePdfRenderer } from "../../src/infrastructure/documents/native-pdf-renderer";
import { PostgresIssuanceOperationRepository } from "../../src/infrastructure/persistence/postgres/issuance-operations";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { PostgresDatabase } from "../../src/infrastructure/persistence/postgres/postgres";
import { CommitCuttingProxy } from "../helpers/commit-cutting-proxy";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";
import { ToggleableTcpProxy } from "../helpers/toggleable-tcp-proxy";

/*
 * R1.5B4 §22, §25–§27, §33: dependency outages with the real periodic jobs
 * running (no manual ticks), the deadline sweep during renderer/storage
 * outages, recovery without restart and without resurrection, the A5
 * non-retryable path end to end over HTTP, and a COMMIT made ambiguous at the
 * PostgreSQL wire (both outcomes).
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 120_000;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

/** The real renderer behind a switch: down = probe fails and renders are refused (renderer outage). */
class ToggleableRenderer implements PdfRendererPort {
  available = true;
  private readonly inner = new NativePdfRenderer();

  get rendererVersion(): string {
    return this.inner.rendererVersion;
  }

  probe(): Promise<ProbeOutcome> {
    return this.available ? this.inner.probe() : Promise.resolve(probeFailed("renderer_unavailable"));
  }

  renderPdf(model: IssuedQuoteDocumentModelV2): Promise<Buffer> {
    return this.available ? this.inner.renderPdf(model) : Promise.reject(new DocumentRenderError("renderer_unavailable"));
  }
}

async function environment() {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());
  await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-adversarial-"));
  cleanups.push(() => fsPromises.rm(`${storageRoot}.offline`, { recursive: true, force: true }));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;
  const target = new URL(database.connectionString);

  async function app(options: { databaseUrl?: string; budgetMs?: number; overrides?: BuildApplicationOverrides } = {}) {
    const env = buildRuntimeTestEnv({
      databaseUrl: options.databaseUrl ?? database.connectionString,
      storageRoot,
      overrides: {
        QUOTE_ISSUANCE_DEADLINE_MS: "3600000",
        QUOTE_ISSUANCE_LEASE_MS: "60000",
        QUOTE_ISSUANCE_POLL_INTERVAL_MS: "500",
        QUOTE_ISSUANCE_SYNC_BUDGET_MS: String(options.budgetMs ?? 0)
      }
    });
    const context: ApplicationContext = buildApplication(env, options.overrides ?? {});
    cleanups.push(async () => {
      await context.shutdown("test");
    });
    const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });

    async function call(method: string, pathname: string, token: string, body?: unknown, key: string | null = crypto.randomUUID()) {
      const headers: Record<string, string> = { Authorization: bearer(token) };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (key !== null) {
        headers["Idempotency-Key"] = key;
      }

      const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, text, body: (text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null) as AnyRecord, headers: response.headers };
    }

    return { context, baseUrl, call };
  }

  return {
    connectionString: database.connectionString,
    target: { host: target.hostname, port: Number(target.port || 5432) },
    storageRoot,
    sql,
    app,
    op: async (operationId: string): Promise<AnyRecord> =>
      (await sql(`select *, generation::int as generation from quote_service.issuance_operations where operation_id = $1`, [operationId]))[0]!,
    quote: async (quoteId: string): Promise<AnyRecord> => (await sql(`select * from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!,
    manifests: (quoteId: string) => sql(`select * from quote_service.quote_documents where quote_id = $1`, [quoteId]),
    events: (quoteId: string, type: string) => sql(`select data from quote_service.quote_audit_events where quote_id = $1 and event_type = $2 order by sequence`, [quoteId, type]),
    async travelDeadlinePast(operationId: string): Promise<void> {
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      await admin.query(
        `update quote_service.issuance_operations set deadline_at = clock_timestamp() - interval '1 second', accepted_at = clock_timestamp() - interval '2 hours' where operation_id = $1`,
        [operationId]
      );
      await admin.query("commit");
    },
    /** Storage outage: the root path becomes a plain file (every mkdir/open under it fails); restore puts the directory back. */
    async storageOffline(): Promise<void> {
      await fsPromises.rename(storageRoot, `${storageRoot}.offline`);
      await fsPromises.writeFile(storageRoot, "storage unavailable");
    },
    async storageOnline(): Promise<void> {
      await fsPromises.rm(storageRoot, { force: true });
      await fsPromises.rename(`${storageRoot}.offline`, storageRoot);
    }
  };
}

type Env = Awaited<ReturnType<typeof environment>>;

/** Accepts `count` create-and-issue quotes with an acceptance-only app (no issuance execution), returning their ids. */
async function acceptQuotes(env: Env, count: number): Promise<Array<{ quoteId: string; operationId: string }>> {
  const acceptor = await env.app({ overrides: { disableIssuanceExecution: true } });
  await waitFor(() => acceptor.context.dependencyMonitor.isReady(), 15_000);
  const accepted: Array<{ quoteId: string; operationId: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const body = example("create-and-issue.request.json");
    const response = await acceptor.call("POST", "/v2/quotes", TEST_TOKENS.sales, {
      ...body,
      externalCorrelation: { ...body.externalCorrelation, externalReference: `outage-${index}-${crypto.randomUUID()}` }
    });
    expect(response.status).toBe(202);
    accepted.push({ quoteId: response.body.quote.quoteId, operationId: response.body.operation.operationId });
  }

  await acceptor.context.shutdown("test");
  return accepted;
}

describe("dependency outages with the real periodic jobs", () => {
  it(
    "PostgreSQL outage: process stays live, business readiness false, no claim and no deadline mutation; recovery issues without restart",
    async () => {
      const env = await environment();
      const [pending] = await acceptQuotes(env, 1);
      const proxy = await ToggleableTcpProxy.create(env.target.host, env.target.port);
      cleanups.push(() => proxy.dispose());
      await proxy.disable();

      const service = await env.app({ databaseUrl: proxy.route(env.connectionString) });
      const monitor = service.context.dependencyMonitor;
      await sleep(3_000);

      expect(monitor.isPersistenceReady()).toBe(false);
      expect((await fetch(`${service.baseUrl}/health/live`)).status).toBe(200);
      expect((await fetch(`${service.baseUrl}/health/ready`)).status).toBe(503);
      const read = await service.call("GET", `/v2/quotes/${pending!.quoteId}`, TEST_TOKENS.sales, undefined, null);
      expect(read.status).toBe(503);
      expect(read.body).toMatchObject({ error: { code: "dependency_unavailable", details: { dependency: "database" } } });
      // Nothing happened to the operation while the database was unreachable (verified on a direct connection).
      expect(await env.op(pending!.operationId)).toMatchObject({ status: "pending", attempt_count: 0, generation: 0, last_error_code: null });

      await proxy.enable();
      await waitFor(async () => (await env.quote(pending!.quoteId)).status === "issued", 30_000);
      expect(await env.op(pending!.operationId)).toMatchObject({ status: "succeeded", attempt_count: 1, last_error_code: null });
      expect(monitor.isReady()).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  for (const outage of ["storage", "renderer"] as const) {
    it(
      `${outage} outage past the deadline: attempts pause, the DB-only deadline sweep still fails the overdue operation (issuance_deadline_exceeded), quote stays issuing; recovery issues the others and never resurrects the failed one`,
      async () => {
        const env = await environment();
        const [overdue, healthy] = await acceptQuotes(env, 2);
        const renderer = new ToggleableRenderer();

        if (outage === "storage") {
          await env.storageOffline();
        } else {
          renderer.available = false;
        }

        const service = await env.app({ overrides: { pdfRenderer: renderer } });
        const monitor = service.context.dependencyMonitor;
        await waitFor(() => monitor.isPersistenceReady(), 15_000);
        expect(monitor.isReady()).toBe(false);
        expect(monitor.businessGate()).toMatchObject({ dependency: outage === "storage" ? "artifactStorage" : "renderer" });

        await env.travelDeadlinePast(overdue!.operationId);
        await waitFor(async () => (await env.op(overdue!.operationId)).status === "failed", 15_000);

        expect(await env.op(overdue!.operationId)).toMatchObject({ status: "failed", last_error_code: "issuance_deadline_exceeded", attempt_count: 0 });
        expect(await env.quote(overdue!.quoteId)).toMatchObject({ status: "issuing" });
        expect((await env.events(overdue!.quoteId, "quote.issue.failed")).map((event) => event.data.errorCode)).toEqual(["issuance_deadline_exceeded"]);
        // Attempts are paused during the outage: the other operation was never claimed.
        expect(await env.op(healthy!.operationId)).toMatchObject({ status: "pending", attempt_count: 0 });
        expect((await fetch(`${service.baseUrl}/health/live`)).status).toBe(200);

        if (outage === "storage") {
          await env.storageOnline();
        } else {
          renderer.available = true;
        }

        await waitFor(async () => (await env.quote(healthy!.quoteId)).status === "issued", 30_000);
        await sleep(2_000);
        // No resurrection: terminal, no further attempt, no document, quote still issuing.
        expect(await env.op(overdue!.operationId)).toMatchObject({ status: "failed", last_error_code: "issuance_deadline_exceeded", attempt_count: 0 });
        expect(await env.quote(overdue!.quoteId)).toMatchObject({ status: "issuing" });
        expect(await env.manifests(overdue!.quoteId)).toEqual([]);
        expect((await env.events(overdue!.quoteId, "quote.issue.failed"))).toHaveLength(1);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe("A5 end to end: deterministic non-retryable failure", () => {
  it(
    "unsupported glyph over HTTP → T12 at once (document_generation_failed), quote issuing, no repeated attempt, no deadline substitution, no document; T10 remains possible",
    async () => {
      const env = await environment();
      const service = await env.app({ budgetMs: 10_000 });
      await waitFor(() => service.context.dependencyMonitor.isReady(), 15_000);
      const draft = await service.call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, { ...example("draft-create.request.json"), customer: { kind: "person", displayName: "Cliente 漢字" } });
      expect(draft.status).toBe(201);
      const issued = await service.call("POST", `/v2/quotes/${draft.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 });

      expect(issued.status).toBe(202);
      expect(issued.body.operation).toMatchObject({ status: "failed", attempts: { count: 1, lastErrorCode: "document_generation_failed", nextAttemptAt: null } });
      const operationId = issued.body.operation.operationId as string;
      await sleep(2_500); // five worker ticks
      expect(await env.op(operationId)).toMatchObject({ status: "failed", attempt_count: 1, last_error_code: "document_generation_failed" });
      expect(await env.quote(draft.body.quoteId)).toMatchObject({ status: "issuing" });
      expect(await env.events(draft.body.quoteId, "quote.issue.attempt_failed")).toEqual([]);
      expect((await env.events(draft.body.quoteId, "quote.issue.failed")).map((event) => event.data)).toEqual([
        expect.objectContaining({ errorCode: "document_generation_failed", retryable: false, reason: "unsupported_glyph" })
      ]);
      const document = await service.call("GET", `/v2/quotes/${draft.body.quoteId}/document`, TEST_TOKENS.backoffice, undefined, null);
      expect(document.status).toBe(409);
      expect(document.body).toMatchObject({ error: { code: "document_not_available", details: { status: "issuing" } } });

      const database = new PostgresDatabase(buildRuntimeTestEnv({ databaseUrl: env.connectionString, storageRoot: env.storageRoot }));
      cleanups.push(() => database.close());
      const repository = new PostgresIssuanceOperationRepository(database, { leaseMs: 60_000, deadlineMs: 3_600_000 });
      expect((await repository.createOperatorRetry({ quoteId: draft.body.quoteId, failedOperationId: operationId, actorPrincipalId: "backoffice" })).kind).toBe("RETRY_CREATED");
    },
    TEST_TIMEOUT_MS
  );
});

describe("T5 COMMIT outcome unknown at the PostgreSQL wire", () => {
  for (const mode of ["drop_commit", "drop_commit_response"] as const) {
    it(
      `${mode === "drop_commit" ? "A: the COMMIT never reached the server (rolled back)" : "B: the COMMIT landed, its reply was lost"} → reconciled from durable state, issued exactly once, 201 from durable state`,
      async () => {
        const env = await environment();
        const proxy = await CommitCuttingProxy.create(env.target.host, env.target.port);
        cleanups.push(() => proxy.dispose());
        const service = await env.app({ databaseUrl: proxy.route(env.connectionString), budgetMs: 10_000 });
        await waitFor(() => service.context.dependencyMonitor.isReady(), 15_000);
        proxy.arm(mode);

        const created = await service.call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
        expect(proxy.cuts.map((cut) => cut.mode)).toEqual([mode]);
        expect(created.status).toBe(201);
        const { quoteId } = created.body.quote;
        const { operationId } = created.body.operation;

        expect(await env.op(operationId)).toMatchObject({ status: "succeeded", attempt_count: 1, generation: 1, last_error_code: null });
        const manifests = await env.manifests(quoteId);
        expect(manifests).toHaveLength(1);
        expect(manifests[0]).toMatchObject({ operation_id: operationId, pdf_sha256: created.body.quote.document.pdfSha256 });
        expect(await env.events(quoteId, "quote.issued")).toHaveLength(1);
        expect(await env.events(quoteId, "quote.issue.attempt_failed")).toEqual([]);
        expect((await env.sql(`select count(*)::int as n from quote_service.quote_deliveries`))[0]!.n).toBe(0);

        const document = await fetch(`${service.baseUrl}/v2/quotes/${quoteId}/document`, { headers: { Authorization: bearer(TEST_TOKENS.sales) } });
        expect(document.status).toBe(200);
        expect(sha256(Buffer.from(await document.arrayBuffer()))).toBe(manifests[0]!.pdf_sha256);
      },
      TEST_TIMEOUT_MS
    );
  }
});
