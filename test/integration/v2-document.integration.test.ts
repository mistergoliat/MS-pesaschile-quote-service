/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type BuildApplicationOverrides } from "../../src/app";
import { FilesystemContentAddressedArtifactStore } from "../../src/infrastructure/documents/content-addressed-artifact-store";
import { verifyDocumentArtifacts } from "../../src/infrastructure/documents/document-artifact-verifier";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { buildRuntimeTestEnv, waitFor } from "../helpers/runtime-test-env";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, TEST_TOKENS } from "../helpers/test-principals";
import { migrateToV1Head, seedV1Snapshot, V1_IDS, V1_PDF_BYTES } from "../helpers/v1-fixture";

/*
 * R1.5B4: GET /v2/quotes/{quoteId}/document (openapi getQuoteDocument,
 * Domain §9.3, state machine §4) and the integrity verifier, on real
 * PostgreSQL, the real renderer and the real content-addressed store.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 120_000;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 30_000);

async function environment(options: { readonly databaseUrl?: string } = {}) {
  let databaseUrl = options.databaseUrl;

  if (!databaseUrl) {
    const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => database.dispose());
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
    databaseUrl = database.connectionString;
  }

  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-document-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;
  const env = buildRuntimeTestEnv({
    databaseUrl,
    storageRoot,
    overrides: {
      LOG_LEVEL: "info",
      QUOTE_ISSUANCE_DEADLINE_MS: "3600000",
      QUOTE_ISSUANCE_POLL_INTERVAL_MS: "500",
      QUOTE_ISSUANCE_SYNC_BUDGET_MS: "10000"
    }
  });
  const logs: AnyRecord[] = [];

  async function app(overrides: BuildApplicationOverrides = {}) {
    const context = buildApplication(env, {
      logStream: { write: (line: string) => void logs.push(JSON.parse(line) as AnyRecord) },
      ...overrides
    });
    cleanups.push(async () => {
      await context.shutdown("test");
    });
    const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
    await waitFor(() => context.dependencyMonitor.isReady(), 15_000);

    async function call(method: string, pathname: string, token: string, body?: unknown, key: string | null = crypto.randomUUID()) {
      const headers: Record<string, string> = { Authorization: bearer(token), "X-Correlation-Id": "req-b4-document" };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      if (key !== null) {
        headers["Idempotency-Key"] = key;
      }

      const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as AnyRecord, headers: response.headers };
    }

    async function document(quoteId: string, token: string) {
      const response = await fetch(`${baseUrl}/v2/quotes/${quoteId}/document`, { headers: { Authorization: bearer(token), "X-Correlation-Id": "req-b4-doc" } });
      const bytes = Buffer.from(await response.arrayBuffer());
      const json = response.headers.get("content-type")?.startsWith("application/json") ? (JSON.parse(bytes.toString("utf8")) as AnyRecord) : null;
      return { status: response.status, headers: response.headers, bytes, json };
    }

    return { context, baseUrl, call, document };
  }

  return {
    databaseUrl,
    storageRoot,
    sql,
    logs,
    app,
    store: new FilesystemContentAddressedArtifactStore(storageRoot),
    manifest: async (quoteId: string): Promise<AnyRecord> =>
      (await sql(`select *, byte_length::int as byte_length from quote_service.quote_documents where quote_id = $1`, [quoteId]))[0]!,
    pathOf: (key: string) => path.join(storageRoot, ...key.split("/")),
    tableSnapshot: async () => ({
      quotes: await sql(`select quote_id, status, version, updated_at from quote_service.quotes order by quote_id`),
      operations: await sql(`select operation_id, status, generation::text, attempt_count from quote_service.issuance_operations order by operation_id`),
      documents: await sql(`select * from quote_service.quote_documents order by document_id`),
      audit: await sql(`select count(*)::int as n from quote_service.quote_audit_events`)
    })
  };
}

describe("GET /v2/quotes/{quoteId}/document", () => {
  it(
    "availability by state: draft, issuing and cancelled-before-issue → 409 document_not_available; issued, expired and cancelled-after-issue → 200 with the same verified bytes",
    async () => {
      const env = await environment();
      // Acceptance only first (no worker), so an `issuing` quote can be observed.
      const accept = await env.app({ disableIssuanceExecution: true });

      const draft = await accept.call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, example("draft-create.request.json"));
      expect(draft.status).toBe(201);
      const draftDocument = await accept.document(draft.body.quoteId, TEST_TOKENS.backoffice);
      expect(draftDocument.status).toBe(409);
      expect(draftDocument.json).toMatchObject({ error: { code: "document_not_available", details: { status: "draft" } } });
      expect(Object.keys(draftDocument.json!.error).sort()).toEqual(Object.keys(example("error.document-not-available.json").error).sort());

      const cancelledDraft = await accept.call("POST", `/v2/quotes/${draft.body.quoteId}/cancel`, TEST_TOKENS.backoffice, { expectedVersion: 1, reasonCode: "customer_declined" });
      expect(cancelledDraft.status).toBe(200);
      expect((await accept.document(draft.body.quoteId, TEST_TOKENS.backoffice)).json).toMatchObject({
        error: { code: "document_not_available", details: { status: "cancelled" } }
      });

      const issuing = await accept.call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
      expect(issuing.status).toBe(202);
      const quoteId = issuing.body.quote.quoteId as string;
      const issuingDocument = await accept.document(quoteId, TEST_TOKENS.sales);
      expect(issuingDocument.status).toBe(409);
      expect(issuingDocument.json).toMatchObject({ error: { code: "document_not_available", details: { status: "issuing" } } });
      expect(issuingDocument.bytes.includes(Buffer.from("%PDF"))).toBe(false);
      // Nothing was rendered on demand.
      expect(fs.existsSync(path.join(env.storageRoot, "artifacts", "sha256"))).toBe(false);

      // The real service issues it in the background; then the document is served.
      const service = await env.app();
      await waitFor(async () => (await env.sql(`select status from quote_service.quotes where quote_id = $1`, [quoteId]))[0]?.status === "issued", 30_000);
      const manifest = await env.manifest(quoteId);
      const issued = await service.document(quoteId, TEST_TOKENS.sales);
      expect(issued.status).toBe(200);
      expect(sha256(issued.bytes)).toBe(manifest.pdf_sha256);
      expect(issued.bytes.equals(fs.readFileSync(env.pathOf(manifest.storage_key)))).toBe(true);

      // Expiry projection keeps the historical formal document.
      const future = await env.app({ disableIssuanceExecution: true, quoteClock: { now: () => Promise.resolve(new Date("2099-01-01T00:00:00.000Z")) } });
      expect((await future.call("GET", `/v2/quotes/${quoteId}`, TEST_TOKENS.sales, undefined, null)).body.status).toBe("expired");
      const expired = await future.document(quoteId, TEST_TOKENS.sales);
      expect(expired.status).toBe(200);
      expect(expired.bytes.equals(issued.bytes)).toBe(true);

      // Cancel-after-issue through the API (creator with the cancel scope).
      const own = await service.call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, example("draft-create.request.json"));
      const ownIssued = await service.call("POST", `/v2/quotes/${own.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 });
      expect(ownIssued.status).toBe(200);
      const ownBytes = (await service.document(own.body.quoteId, TEST_TOKENS.backoffice)).bytes;
      const ownCancel = await service.call("POST", `/v2/quotes/${own.body.quoteId}/cancel`, TEST_TOKENS.backoffice, {
        expectedVersion: ownIssued.body.quote.version,
        reasonCode: "customer_declined"
      });
      expect(ownCancel.status).toBe(200);
      expect(ownCancel.body).toMatchObject({ status: "cancelled", document: { available: true } });
      const cancelledAfterIssue = await service.document(own.body.quoteId, TEST_TOKENS.backoffice);
      expect(cancelledAfterIssue.status).toBe(200);
      expect(cancelledAfterIssue.bytes.equals(ownBytes)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "authorization: creator and quotes:read:any read it; a non-visible principal gets exactly the GET quote 404; a principal without quotes:document:read gets 403",
    async () => {
      const env = await environment();
      const service = await env.app();
      const created = await service.call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
      expect(created.status).toBe(201);
      const salesQuote = created.body.quote.quoteId as string;
      const draft = await service.call("POST", "/v2/quotes/drafts", TEST_TOKENS.backoffice, example("draft-create.request.json"));
      expect((await service.call("POST", `/v2/quotes/${draft.body.quoteId}/issue`, TEST_TOKENS.backoffice, { expectedVersion: 1 })).status).toBe(200);
      const backofficeQuote = draft.body.quoteId as string;

      // Creator.
      expect((await service.document(salesQuote, TEST_TOKENS.sales)).status).toBe(200);
      // quotes:read:any + quotes:document:read on a foreign quote.
      const foreign = await service.document(salesQuote, TEST_TOKENS.backoffice);
      expect(foreign.status).toBe(200);
      expect(sha256(foreign.bytes)).toBe(created.body.quote.document.pdfSha256);

      // Not visible (sales has no read:any): indistinguishable from a missing quote and from GET quote.
      const hidden = await service.document(backofficeQuote, TEST_TOKENS.sales);
      const hiddenQuote = await service.call("GET", `/v2/quotes/${backofficeQuote}`, TEST_TOKENS.sales, undefined, null);
      const missing = await service.document(crypto.randomUUID(), TEST_TOKENS.sales);
      expect(hidden.status).toBe(404);
      expect(hiddenQuote.status).toBe(404);
      const shape = (body: AnyRecord) => ({ code: body.error.code, message: body.error.message, details: body.error.details });
      expect(shape(hidden.json!)).toEqual(shape(hiddenQuote.body));
      expect(shape(hidden.json!)).toEqual(shape(missing.json!));
      expect(hidden.json).toMatchObject({ error: { code: "quote_not_found" } });

      // Scope: quotes:read without quotes:document:read.
      const noScope = await service.document(salesQuote, TEST_TOKENS.pricingDesk);
      expect(noScope.status).toBe(403);
      expect(noScope.json).toMatchObject({ error: { code: "forbidden" } });
      expect((await service.document(salesQuote, "not-a-token")).status).toBe(401);
      // Path validation precedes authentication.
      expect((await service.document("not-a-uuid", TEST_TOKENS.sales)).status).toBe(400);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "response: exact bytes, frozen headers (X-Document-Sha256, strong ETag, attachment filename from quoteNumber), no storage path or key anywhere",
    async () => {
      const env = await environment();
      const service = await env.app();
      const created = await service.call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"), "doc-headers");
      expect(created.status).toBe(201);
      const quote = created.body.quote;
      const manifest = await env.manifest(quote.quoteId);
      const response = await service.document(quote.quoteId, TEST_TOKENS.sales);

      expect(response.status).toBe(200);
      expect(response.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(sha256(response.bytes)).toBe(quote.document.pdfSha256);
      expect(response.bytes.byteLength).toBe(quote.document.byteLength);
      expect(Object.fromEntries(["content-type", "content-length", "content-disposition", "x-document-sha256", "etag", "cache-control", "x-content-type-options"].map((name) => [name, response.headers.get(name)]))).toEqual({
        "content-type": "application/pdf",
        "content-length": String(quote.document.byteLength),
        "content-disposition": `attachment; filename="${quote.quoteNumber}.pdf"`,
        "x-document-sha256": quote.document.pdfSha256,
        etag: `"${quote.document.pdfSha256}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      });
      expect(response.headers.get("x-request-id") ?? "").not.toContain(env.storageRoot);
      const allHeaders = JSON.stringify([...response.headers.entries()]);
      expect(allHeaders).not.toContain(manifest.storage_key);
      expect(allHeaders).not.toContain("artifacts/");
      expect(allHeaders).not.toContain(path.basename(env.storageRoot));
      // The quote representation never exposes storage either.
      expect(JSON.stringify(created.body)).not.toMatch(/artifacts\/|storage_?key|quote-document-/i);

      // Reading never writes: the store and the database are unchanged.
      const before = { tables: await env.tableSnapshot(), stat: fs.statSync(env.pathOf(manifest.storage_key)).mtimeMs };
      await service.document(quote.quoteId, TEST_TOKENS.sales);
      expect({ tables: await env.tableSnapshot(), stat: fs.statSync(env.pathOf(manifest.storage_key)).mtimeMs }).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "integrity: tampered (same and different length) and missing artifacts → 503 document_storage_failed, no PDF bytes sent, nothing regenerated or repaired, quote and manifest unchanged, operator signal logged; the verifier reports them",
    async () => {
      const env = await environment();
      const service = await env.app();
      const issue = async (key: string) => {
        const created = await service.call("POST", "/v2/quotes", TEST_TOKENS.sales, { ...example("create-and-issue.request.json"), externalCorrelation: { ...example("create-and-issue.request.json").externalCorrelation, externalReference: key } }, key);
        expect(created.status).toBe(201);
        return { quoteId: created.body.quote.quoteId as string, manifest: await env.manifest(created.body.quote.quoteId) };
      };
      const healthy = await issue("doc-healthy");
      const tampered = await issue("doc-tampered");
      const truncated = await issue("doc-truncated");
      const missing = await issue("doc-missing");
      const before = await env.tableSnapshot();

      // Same-length bit flip.
      const tamperedPath = env.pathOf(tampered.manifest.storage_key);
      const bytes = fs.readFileSync(tamperedPath);
      bytes[bytes.byteLength - 10] = bytes[bytes.byteLength - 10]! ^ 0x01;
      fs.writeFileSync(tamperedPath, bytes);
      const tamperedBytes = Buffer.from(bytes);
      fs.writeFileSync(env.pathOf(truncated.manifest.storage_key), fs.readFileSync(env.pathOf(truncated.manifest.storage_key)).subarray(0, 1000));
      const lostBytes = fs.readFileSync(env.pathOf(missing.manifest.storage_key));
      fs.rmSync(env.pathOf(missing.manifest.storage_key));
      const filesBefore = fs.readdirSync(path.join(env.storageRoot, "artifacts", "sha256"), { recursive: true }).map(String).sort();

      for (const [label, target] of [["tampered", tampered], ["truncated", truncated], ["missing", missing]] as const) {
        const response = await service.document(target.quoteId, TEST_TOKENS.sales);
        expect(response.status, label).toBe(503);
        expect(response.headers.get("content-type"), label).toMatch(/^application\/json/);
        expect(response.headers.get("retry-after"), label).toBe("5");
        expect(response.json, label).toEqual({ error: { code: "document_storage_failed", message: expect.any(String), requestId: expect.any(String) } });
        expect(response.bytes.includes(Buffer.from("%PDF")), label).toBe(false);
        expect(response.bytes.toString("utf8"), label).not.toMatch(/artifacts|sha256\/|quote-document-|[A-Z]:\\|\/tmp\//);
        // The quote is still formally issued with the same manifest.
        const quote = await service.call("GET", `/v2/quotes/${target.quoteId}`, TEST_TOKENS.sales, undefined, null);
        expect(quote.body, label).toMatchObject({ status: "issued", document: { available: true, pdfSha256: target.manifest.pdf_sha256 } });
      }

      expect((await service.document(healthy.quoteId, TEST_TOKENS.sales)).status).toBe(200);
      // No regeneration, repair or overwrite: database and storage exactly as the operator left them.
      expect(await env.tableSnapshot()).toEqual(before);
      expect(fs.readdirSync(path.join(env.storageRoot, "artifacts", "sha256"), { recursive: true }).map(String).sort()).toEqual(filesBefore);
      expect(fs.existsSync(env.pathOf(missing.manifest.storage_key))).toBe(false);
      expect(fs.readFileSync(tamperedPath).equals(tamperedBytes)).toBe(true);

      // Operator-visible signal: ids and status only, never a path.
      const signals = env.logs.filter((line) => line.event === "document.integrity_failed");
      expect(signals.map((line) => [line.quoteId, line.integrityStatus])).toEqual([
        [tampered.quoteId, "HASH_MISMATCH"],
        [truncated.quoteId, "LENGTH_MISMATCH"],
        [missing.quoteId, "MISSING"]
      ]);
      expect(signals.every((line) => line.level === 50 && line.origin === "issuance" && typeof line.documentId === "string")).toBe(true);
      expect(JSON.stringify(env.logs)).not.toContain(env.storageRoot.replaceAll("\\", "\\\\"));
      expect(JSON.stringify(env.logs)).not.toContain(tampered.manifest.storage_key);

      // The verifier (library) classifies the same artifacts without changing anything.
      const report = await verifyDocumentArtifacts({ database: { query: (text: string, values?: unknown[]) => env.sql(text, values).then((rows) => ({ rows })) } as never, store: env.store, recordLegacyByteLength: false, batchSize: 2 });
      expect(report).toMatchObject({ checked: 4, ok: 1, byteLengthsRecorded: 0 });
      expect(Object.fromEntries(report.problems.map((problem) => [problem.quoteId, problem.status]))).toEqual({
        [tampered.quoteId]: "HASH_MISMATCH",
        [truncated.quoteId]: "LENGTH_MISMATCH",
        [missing.quoteId]: "MISSING"
      });
      expect(await env.tableSnapshot()).toEqual(before);

      // Only bytes reproducing the recorded hash (a future operator restore procedure) are ever served again.
      fs.writeFileSync(env.pathOf(missing.manifest.storage_key), Buffer.alloc(0));
      expect((await service.document(missing.quoteId, TEST_TOKENS.sales)).status).toBe(503);
      fs.writeFileSync(env.pathOf(missing.manifest.storage_key), lostBytes);
      const restored = await service.document(missing.quoteId, TEST_TOKENS.sales);
      expect(restored.status).toBe(200);
      expect(restored.bytes.equals(lostBytes)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "operator command documents:verify: exit 0 when every artifact verifies, exit 2 with categorized ids (no paths) after corruption; read-only",
    async () => {
      const env = await environment();
      const service = await env.app();
      const created = await service.call("POST", "/v2/quotes", TEST_TOKENS.sales, example("create-and-issue.request.json"));
      expect(created.status).toBe(201);
      const manifest = await env.manifest(created.body.quote.quoteId);

      const run = (): Promise<{ code: number | null; stdout: string }> =>
        new Promise((resolve) => {
          let stdout = "";
          const child = spawn(process.execPath, ["--import", "tsx", "src/scripts/verify-document-artifacts.ts"], {
            cwd: process.cwd(),
            env: { ...process.env, DATABASE_URL: env.databaseUrl, QUOTE_DOCUMENT_STORAGE_ROOT: env.storageRoot },
            stdio: ["ignore", "pipe", "pipe"]
          });
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
          child.on("exit", (code) => resolve({ code, stdout }));
        });

      const clean = await run();
      expect(clean.code).toBe(0);
      expect(JSON.parse(clean.stdout)).toMatchObject({ status: "ok", checked: 1, ok: 1, problems: [] });

      fs.appendFileSync(env.pathOf(manifest.storage_key), "x");
      const before = await env.tableSnapshot();
      const corrupt = await run();
      expect(corrupt.code).toBe(2);
      const report = JSON.parse(corrupt.stdout);
      expect(report).toMatchObject({ status: "exceptions", checked: 1, ok: 0, byStatus: { LENGTH_MISMATCH: 1 } });
      expect(report.problems).toEqual([{ documentId: manifest.document_id, quoteId: manifest.quote_id, origin: "issuance", status: "LENGTH_MISMATCH" }]);
      expect(corrupt.stdout).not.toContain(env.storageRoot);
      expect(corrupt.stdout).not.toContain(manifest.storage_key);
      expect(await env.tableSnapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "migrated V1 documents (legacy key, byteLength null) are served after hash verification, also when expired or cancelled after issue; never-issued V1 drafts have none",
    async () => {
      const handle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
      cleanups.push(() => handle.dispose());
      await migrateToV1Head(handle.connectionString);
      await seedV1Snapshot(handle.connectionString);
      await runMigrations({ databaseUrl: handle.connectionString, direction: "up" });
      const env = await environment({ databaseUrl: handle.connectionString });
      const legacy = await env.sql(`select quote_id, storage_key, byte_length, origin from quote_service.quote_documents order by quote_id`);
      expect(legacy.every((row) => row.origin === "legacy_v1" && row.byte_length === null)).toBe(true);

      for (const row of legacy) {
        fs.mkdirSync(path.dirname(env.pathOf(row.storage_key)), { recursive: true });
        fs.writeFileSync(env.pathOf(row.storage_key), V1_PDF_BYTES[row.quote_id]!);
      }

      const service = await env.app({ disableIssuanceExecution: true });

      for (const quoteId of [V1_IDS.issued, V1_IDS.expired, V1_IDS.cancelledIssued]) {
        const response = await service.document(quoteId, TEST_TOKENS.backoffice);
        expect(response.status, quoteId).toBe(200);
        expect(response.bytes.equals(V1_PDF_BYTES[quoteId]!), quoteId).toBe(true);
        expect(response.headers.get("content-length"), quoteId).toBe(String(V1_PDF_BYTES[quoteId]!.byteLength));
        expect(response.headers.get("x-document-sha256"), quoteId).toBe(sha256(V1_PDF_BYTES[quoteId]!));
        expect(response.headers.get("content-disposition"), quoteId).toMatch(/^attachment; filename="PC-[0-9]{6}\.pdf"$/);
      }

      expect((await service.document(V1_IDS.cancelledDraft, TEST_TOKENS.backoffice)).json).toMatchObject({
        error: { code: "document_not_available", details: { status: "cancelled" } }
      });
      // Legacy quotes belong to `legacy-v1`: invisible without quotes:read:any.
      expect((await service.document(V1_IDS.issued, TEST_TOKENS.sales)).status).toBe(404);
      // A legacy byteLength stays unknown: serving it records nothing.
      expect((await env.sql(`select count(*)::int as n from quote_service.quote_documents where byte_length is not null`))[0]!.n).toBe(0);

      fs.writeFileSync(env.pathOf(legacy.find((row) => row.quote_id === V1_IDS.issued)!.storage_key), "altered");
      expect((await service.document(V1_IDS.issued, TEST_TOKENS.backoffice)).json).toMatchObject({ error: { code: "document_storage_failed" } });
    },
    TEST_TIMEOUT_MS
  );
});
