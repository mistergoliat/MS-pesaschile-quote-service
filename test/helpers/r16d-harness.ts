/* eslint-disable @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { buildApplication, type ApplicationContext, type BuildApplicationOverrides } from "../../src/app";
import { probeFailed } from "../../src/application/health/dependency-state";
import type { PdfRendererPort } from "../../src/application/quote-v2/document/pdf-renderer-port";
import { PrincipalRegistry } from "../../src/infrastructure/auth/principal-registry";
import { NativePdfRenderer } from "../../src/infrastructure/documents/native-pdf-renderer";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { buildRuntimeTestEnv, waitFor } from "./runtime-test-env";
import { createTestDatabase } from "./test-database";
import { bearer, sha256Hex, TEST_TOKENS, testRegistryDocument } from "./test-principals";
import { ToggleableTcpProxy } from "./toggleable-tcp-proxy";

/*
 * Shared harness of the R1.6D suites (capability gating, expiry, integrity,
 * metrics, V1 retirement, redaction): a real application on a fresh migrated
 * database behind a toggleable TCP proxy (database outage), a real
 * NativePdfRenderer whose probe can be failed (renderer outage) and a real
 * storage root that can be swapped for a plain file (storage outage). All
 * three are states the production DependencyMonitor reaches on its own.
 * Periodic runners are slowed to an hour; tests drive them explicitly.
 */

export type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CLERK_TOKEN = "test-r16d-clerk-token-0123456789abcdefghijklmnopqrstu";
export const MONITORING_TOKEN = TEST_TOKENS.monitoring;

export const example = (name: string): AnyRecord =>
  JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;

export function clerkRegistry(): PrincipalRegistry {
  const document = testRegistryDocument();
  document.principals.push({
    principalId: "clerk",
    principalType: "operator",
    scopes: [
      "quotes:create", "quotes:draft:write", "quotes:issue", "quotes:read", "quotes:cancel",
      "quotes:audit:read", "quotes:delivery:email", "quotes:document:read"
    ],
    tokenSha256: [sha256Hex(CLERK_TOKEN)]
  });
  return PrincipalRegistry.load({ kind: "inline", json: JSON.stringify(document) });
}

export interface HarnessOptions {
  readonly cleanups: Array<() => Promise<void>>;
  readonly env?: Record<string, string>;
  readonly overrides?: BuildApplicationOverrides;
  /** Captured log lines (LOG_LEVEL trace). */
  readonly logs?: string[];
  /** Existing migrated database (another instance of the same deployment). */
  readonly databaseUrl?: string;
  readonly storageRoot?: string;
}

export interface CallInput {
  readonly token?: string | null;
  readonly key?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export async function startHarness(options: HarnessOptions) {
  const { cleanups } = options;
  let databaseUrl = options.databaseUrl;

  if (!databaseUrl) {
    const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
    cleanups.push(() => database.dispose());
    await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
    databaseUrl = database.connectionString;
  }

  let storageRoot = options.storageRoot;

  if (!storageRoot) {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-r16d-"));
    cleanups.push(() => fsPromises.rm(root, { recursive: true, force: true }));
    storageRoot = root;
  }

  const target = new URL(databaseUrl);
  const proxy = await ToggleableTcpProxy.create(target.hostname, Number(target.port || 5432));
  cleanups.push(() => proxy.dispose());

  const real = new NativePdfRenderer();
  const faults = { renderer: false };
  const renderer: PdfRendererPort = {
    rendererVersion: real.rendererVersion,
    renderPdf: (model) => real.renderPdf(model),
    probe: () => (faults.renderer ? Promise.resolve(probeFailed("renderer_unavailable")) : real.probe())
  };

  const context: ApplicationContext = buildApplication(
    buildRuntimeTestEnv({
      databaseUrl: proxy.route(databaseUrl),
      storageRoot,
      overrides: {
        LOG_LEVEL: options.logs ? "trace" : "silent",
        QUOTE_ISSUANCE_POLL_INTERVAL_MS: "60000",
        QUOTE_EMAIL_POLL_INTERVAL_MS: "60000",
        QUOTE_ISSUANCE_SYNC_BUDGET_MS: "10000",
        ...options.env
      }
    }),
    {
      principalRegistry: clerkRegistry(),
      pdfRenderer: renderer,
      ...(options.logs ? { logStream: { write: (line: string) => void options.logs!.push(line) } } : {}),
      ...options.overrides
    }
  );
  cleanups.push(async () => {
    await context.shutdown("test-cleanup");
  });
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  await waitFor(async () => (await fetch(`${baseUrl}/health/ready`)).status === 200, 30_000, 50);

  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  cleanups.push(() => admin.end());
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;
  const root = storageRoot;

  async function call(method: string, pathname: string, input: CallInput = {}) {
    const headers: Record<string, string> = { ...input.headers };

    if (input.token !== null) {
      headers.Authorization = bearer(input.token ?? CLERK_TOKEN);
    }

    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (input.key) {
      headers["Idempotency-Key"] = input.key;
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      ...(input.body === undefined ? {} : { body: typeof input.body === "string" ? input.body : JSON.stringify(input.body) })
    });
    const isPdf = (response.headers.get("content-type") ?? "").startsWith("application/pdf");
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      text,
      body: (isPdf || bytes.length === 0 ? null : JSON.parse(text)) as AnyRecord
    };
  }

  const harness = {
    context,
    baseUrl,
    databaseUrl,
    storageRoot: root,
    proxy,
    sql,
    call,
    monitor: context.dependencyMonitor,

    /** Create-and-issue through the API with the real renderer (inline attempt): the issued quote, with a committed artifact. */
    async issued(body: AnyRecord = example("create-and-issue.request.json")): Promise<AnyRecord> {
      const response = await call("POST", "/v2/quotes", { key: `create-${crypto.randomUUID()}`, body });

      if (response.status !== 201) {
        throw new Error(`create-and-issue answered ${response.status}: ${response.text}`);
      }

      return response.body.quote as AnyRecord;
    },

    async draft(): Promise<AnyRecord> {
      const response = await call("POST", "/v2/quotes/drafts", { key: `draft-${crypto.randomUUID()}`, body: example("draft-create.request.json") });

      if (response.status !== 201) {
        throw new Error(`draft create answered ${response.status}: ${response.text}`);
      }

      return response.body;
    },

    /**
     * Moves a quote's frozen validity into the past (database time): the
     * boundary becomes `now - agoMs` at millisecond precision. Triggers are
     * bypassed on the superuser connection; CHECK constraints still hold.
     */
    async pastValidity(quoteId: string, agoMs = 60_000): Promise<Date> {
      await admin.query("begin");
      await admin.query("set local session_replication_role = replica");
      const { rows } = await admin.query<{ boundary: Date }>(
        `update quote_service.quotes
         set issued_at = date_trunc('milliseconds', clock_timestamp()) - ($2::bigint + 86400000) * interval '1 millisecond',
             valid_until_exclusive = date_trunc('milliseconds', clock_timestamp()) - $2::bigint * interval '1 millisecond'
         where quote_id = $1
         returning valid_until_exclusive as boundary`,
        [quoteId, agoMs]
      );
      await admin.query("commit");
      return rows[0]!.boundary;
    },

    async quoteRow(quoteId: string): Promise<AnyRecord> {
      return (await sql(`select status, version, expired_at, valid_until_exclusive, updated_at from quote_service.quotes where quote_id = $1`, [quoteId]))[0]!;
    },

    async auditTypes(quoteId: string): Promise<string[]> {
      return (await sql(`select event_type from quote_service.quote_audit_events where quote_id = $1 order by sequence`, [quoteId])).map((row) => row.event_type as string);
    },

    async rendererDown(down: boolean): Promise<void> {
      faults.renderer = down;
      // A cycle already in flight may predate the change: run one that starts after it.
      await context.dependencyMonitor.probeNow();
      await context.dependencyMonitor.probeNow();
    },

    /** Replaces the storage root with a plain file (unmounted volume), or restores it. */
    async storageDown(down: boolean): Promise<void> {
      const away = `${root}.away`;

      if (down) {
        await fsPromises.rename(root, away);
        await fsPromises.writeFile(root, "blocked", "utf8");
      } else {
        await fsPromises.rm(root, { force: true });
        await fsPromises.rename(away, root);
      }

      // A cycle already in flight may predate the change: run one that starts after it.
      await context.dependencyMonitor.probeNow();
      await context.dependencyMonitor.probeNow();
    },

    async databaseDown(down: boolean): Promise<void> {
      await (down ? proxy.disable() : proxy.enable());
      // A cycle already in flight may predate the change: run one that starts after it.
      await context.dependencyMonitor.probeNow();
      await context.dependencyMonitor.probeNow();
    },

    async health(): Promise<AnyRecord> {
      return (await call("GET", "/health/dependencies", { token: MONITORING_TOKEN })).body;
    }
  };

  cleanups.push(async () => {
    // Restore a swapped storage root so the root cleanup removes everything.
    if (fs.existsSync(`${root}.away`)) {
      await fsPromises.rm(root, { force: true });
      await fsPromises.rename(`${root}.away`, root);
    }
  });

  return harness;
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export function freshCleanups(): { cleanups: Array<() => Promise<void>>; run: () => Promise<void> } {
  const cleanups: Array<() => Promise<void>> = [];
  return {
    cleanups,
    run: async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()!().catch(() => undefined);
      }
    }
  };
}
