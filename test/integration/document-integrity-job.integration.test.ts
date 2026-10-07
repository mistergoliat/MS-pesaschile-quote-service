
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../../src/infrastructure/config/env";
import { createDocumentIntegrityJob } from "../../src/infrastructure/runtime/maintenance-jobs";
import { PeriodicJobRunner } from "../../src/infrastructure/runtime/periodic-job-runner";
import { freshCleanups, startHarness, type AnyRecord, type Harness } from "../helpers/r16d-harness";
import { testRegistryJson } from "../helpers/test-principals";

/*
 * R1.6D — periodic document integrity job (Domain §9.4, decision W7:
 * in-process, opt-in, low cadence). It schedules the SAME verifier as
 * `documents:verify` and is detection only: no repair, render, write,
 * manifest/quote change or deletion, and it never affects readiness.
 */

const TEST_TIMEOUT_MS = 120_000;
const ENABLED = { QUOTE_INTEGRITY_CHECK_INTERVAL_MS: "3600000" };
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  vi.restoreAllMocks();
  await run();
}, 60_000);

const parsed = (logs: string[]): AnyRecord[] => logs.map((line) => JSON.parse(line) as AnyRecord);

async function manifestPath(harness: Harness, quoteId: string): Promise<{ file: string; documentId: string; pdfSha256: string }> {
  const [row] = await harness.sql(`select document_id, storage_key, pdf_sha256 from quote_service.quote_documents where quote_id = $1`, [quoteId]);
  return { file: path.join(harness.storageRoot, row!.storage_key as string), documentId: row!.document_id as string, pdfSha256: row!.pdf_sha256 as string };
}

async function tableSnapshot(harness: Harness): Promise<unknown> {
  return harness.sql(
    `select (select jsonb_agg(to_jsonb(q) order by q.quote_id) from quote_service.quotes q) as quotes,
            (select jsonb_agg(to_jsonb(d) order by d.document_id) from quote_service.quote_documents d) as documents,
            (select count(*)::int from quote_service.issuance_operations) as operations,
            (select count(*)::int from quote_service.quote_audit_events) as audit`
  );
}

function storageFiles(harness: Harness): string[] {
  return fs.readdirSync(path.join(harness.storageRoot, "artifacts", "sha256"), { recursive: true }).map(String).sort();
}

describe("document integrity job: configuration (S, T)", () => {
  it("S: disabled by default — no runner is composed and nothing scans", async () => {
    expect(loadEnv({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x", QUOTE_DOCUMENT_STORAGE_ROOT: "/x", QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson() }).QUOTE_INTEGRITY_CHECK_INTERVAL_MS).toBe(0);
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, logs });
    await harness.issued();
    const read = vi.spyOn(harness.context.artifactStorage, "readVerified");

    expect(harness.context.documentIntegrity).toBeNull();
    expect(harness.context.backgroundJobs.status().documentIntegrity.enabled).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(parsed(logs).filter((line) => String(line.event).startsWith("document.integrity"))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("T/U: enabled — a scan runs through the shared verifier; healthy artifacts produce one summary and no failure line", async () => {
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, env: ENABLED, logs });
    await harness.issued();
    await harness.issued();
    const read = vi.spyOn(harness.context.artifactStorage, "readVerified");

    await harness.context.documentIntegrity!.runNow();

    // The verified read of the document endpoint and of documents:verify, once per manifest.
    expect(read).toHaveBeenCalledTimes(2);
    const lines = parsed(logs);
    expect(lines.filter((line) => line.event === "document.integrity_failed")).toEqual([]);
    expect(lines.filter((line) => line.event === "document.integrity_scan_completed")).toEqual([
      expect.objectContaining({ completed: true, checked: 2, ok: 2, problems: 0, level: 30 })
    ]);
    expect(harness.context.backgroundJobs.status().documentIntegrity).toMatchObject({ enabled: true, lastIterationFailed: false });
  }, TEST_TIMEOUT_MS);
});

describe("document integrity job: detection only (V-Z, AE)", () => {
  it("V/W/X/Y/Z/AE: missing, hash and length mismatches are reported with ids/category/hash; nothing is repaired or changed; readiness unaffected", async () => {
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, env: ENABLED, logs });
    const missing = (await harness.issued()).quoteId as string;
    const tampered = (await harness.issued()).quoteId as string;
    const truncated = (await harness.issued()).quoteId as string;
    const healthy = (await harness.issued()).quoteId as string;

    const missingFile = await manifestPath(harness, missing);
    fs.rmSync(missingFile.file);
    const tamperedFile = await manifestPath(harness, tampered);
    const bytes = fs.readFileSync(tamperedFile.file);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
    fs.writeFileSync(tamperedFile.file, bytes);
    const truncatedFile = await manifestPath(harness, truncated);
    fs.appendFileSync(truncatedFile.file, "x");

    const render = vi.spyOn(harness.context.pdfRenderer, "renderPdf");
    const publish = vi.spyOn(harness.context.artifactStorage, "publish");
    const before = await tableSnapshot(harness);
    const filesBefore = storageFiles(harness);
    logs.length = 0;

    await harness.context.documentIntegrity!.runNow();

    const failures = parsed(logs).filter((line) => line.event === "document.integrity_failed");
    expect(failures.map((line) => [line.quoteId as string, line.category as string]).sort()).toEqual(
      [[missing, "MISSING"], [tampered, "HASH_MISMATCH"], [truncated, "LENGTH_MISMATCH"]].sort()
    );
    for (const line of failures) {
      const expected = [missingFile, tamperedFile, truncatedFile].find((file) => file.documentId === line.documentId)!;
      expect(line).toMatchObject({ level: 50, source: "integrity_scan", origin: "issuance", pdfSha256: expected.pdfSha256 });
    }
    expect(parsed(logs).filter((line) => line.event === "document.integrity_scan_completed")).toEqual([
      expect.objectContaining({ completed: true, checked: 4, ok: 1, problems: 3, level: 40 })
    ]);
    // Safe metadata only: no path, storage key, customer data or bytes.
    const text = logs.join("\n");
    expect(text).not.toContain(harness.storageRoot.replaceAll("\\", "\\\\"));
    expect(text).not.toContain("artifacts/sha256");
    expect(text).not.toContain("Camila");
    expect(text).not.toContain("%PDF");

    // Y/Z: no repair, no render, no publish; manifests, quotes, operations and bytes untouched.
    expect(render).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await tableSnapshot(harness)).toEqual(before);
    expect(storageFiles(harness)).toEqual(filesBefore);
    expect(fs.existsSync(missingFile.file)).toBe(false);
    expect(fs.readFileSync(tamperedFile.file).equals(bytes)).toBe(true);

    // AE: readiness is unaffected by a corrupt document; the healthy one is still served.
    expect((await harness.call("GET", "/health/ready", { token: null })).status).toBe(200);
    expect((await harness.call("GET", `/v2/quotes/${healthy}/document`)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("Y (static): the job module never imports the repair command, the renderer or the store's write path", () => {
    const source = fs.readFileSync(path.resolve("src/infrastructure/runtime/maintenance-jobs.ts"), "utf8");
    expect(source).not.toMatch(/document-repair|repairDocument|renderPdf|\.publish\(|unlink|rm\(/);
  }, TEST_TIMEOUT_MS);
});

describe("document integrity job: gating and overlap (AA-AD)", () => {
  it("AA: a renderer outage does not stop the scan", async () => {
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, env: ENABLED, logs });
    await harness.issued();
    await harness.rendererDown(true);
    expect((await harness.call("GET", "/health/ready", { token: null })).status).toBe(503);

    await harness.context.documentIntegrity!.runNow();

    expect(parsed(logs).filter((line) => line.event === "document.integrity_scan_completed")).toEqual([
      expect.objectContaining({ completed: true, checked: 1, ok: 1 })
    ]);
  }, TEST_TIMEOUT_MS);

  it("AB/AC: storage or database down → the job pauses (no scan, no false MISSING reports, no failure)", async () => {
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, env: ENABLED, logs });
    await harness.issued();
    const read = vi.spyOn(harness.context.artifactStorage, "readVerified");

    await harness.storageDown(true);
    await harness.context.documentIntegrity!.runNow();
    await harness.storageDown(false);
    await harness.databaseDown(true);
    await harness.context.documentIntegrity!.runNow();
    await harness.databaseDown(false);

    expect(read).not.toHaveBeenCalled();
    expect(parsed(logs).filter((line) => String(line.event).startsWith("document.integrity"))).toEqual([]);
    expect(parsed(logs).filter((line) => line.event === "job.paused" && line.job === "documentIntegrity").length).toBeGreaterThanOrEqual(1);
    expect(harness.context.backgroundJobs.status().documentIntegrity.lastIterationFailed).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("AB2: storage lost part-way through a scan → the scan stops between batches and reports no per-artifact problem", async () => {
    const logs: string[] = [];
    const harness = await startHarness({ cleanups, env: ENABLED, logs });
    await harness.issued();
    await harness.issued();
    await harness.issued();
    // The production factory with batches of one, so the scan has batch boundaries to stop at.
    const job = createDocumentIntegrityJob({
      database: harness.context.database,
      store: harness.context.artifactStorage,
      intervalMs: 3_600_000,
      readiness: harness.monitor,
      logger: harness.context.app.log,
      batchSize: 1
    });
    const store = harness.context.artifactStorage;
    const original = store.readVerified.bind(store);
    let reads = 0;
    vi.spyOn(store, "readVerified").mockImplementation(async (manifest) => {
      reads += 1;

      if (reads === 1) {
        // The volume disappears after the first artifact; the monitor notices.
        await harness.storageDown(true);
      }

      return original(manifest);
    });

    await job.runNow();

    expect(reads).toBe(1);
    expect(parsed(logs).filter((line) => line.event === "document.integrity_failed")).toEqual([]);
    expect(parsed(logs).filter((line) => line.event === "document.integrity_scan_completed")).toEqual([
      expect.objectContaining({ completed: false, checked: 1, level: 40 })
    ]);
  }, TEST_TIMEOUT_MS);

  it("AD: overlapping ticks in one process share the running scan (single flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const runner = new PeriodicJobRunner({
      name: "documentIntegrity",
      intervalMs: 3_600_000,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      execute: async () => {
        executions += 1;
        await gate;
      }
    });

    const first = runner.runNow();
    const second = runner.runNow();
    const third = runner.runNow();
    release();
    await Promise.all([first, second, third]);

    expect(executions).toBe(1);
  });
});
