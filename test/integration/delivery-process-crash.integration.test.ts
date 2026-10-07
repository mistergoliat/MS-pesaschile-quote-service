/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- contract JSON fixtures and HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import { waitFor } from "../helpers/runtime-test-env";
import { startServiceProcess, type ServiceProcess, type ServiceProcessOptions } from "../helpers/service-process";
import { createTestDatabase } from "../helpers/test-database";
import { bearer, sha256Hex, testRegistryDocument } from "../helpers/test-principals";

/*
 * R1.6B §68–§70: delivery crash matrix with REAL process failure. The worker
 * runs in a separate OS process (test/process/failpoint-server.ts) composed
 * with the REAL Gmail adapter pointed at a fake provider that runs in THIS
 * (parent) process, so the provider's call count survives the worker's
 * SIGKILL. Nothing reaches Gmail or the internet.
 *
 * The invariant under test: for every delivery, the number of automatic
 * provider calls that may have been accepted is at most 1. An expired
 * `sending` lease becomes `unknown`; nothing is ever sent again.
 */

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEST_TIMEOUT_MS = 180_000;
const DELIVERY_LEASE_MS = 15_000;
const TOKEN = "test-delivery-crash-comms-token-0123456789abcdefghijklmnop";
const example = (name: string): AnyRecord => JSON.parse(fs.readFileSync(path.resolve("docs/v2/examples", name), "utf8")) as AnyRecord;
const cleanups: Array<() => Promise<void>> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => undefined);
  }
}, 60_000);

function registryJson(): string {
  const document = testRegistryDocument();
  document.principals.push({
    principalId: "crash-comms",
    principalType: "service",
    scopes: ["quotes:create", "quotes:read", "quotes:document:read", "quotes:delivery:email"],
    tokenSha256: [sha256Hex(TOKEN)]
  });
  return JSON.stringify(document);
}

/** Fake provider in the parent process: counts send requests (each one accepted). */
async function fakeProvider() {
  const sends: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.url === "/token") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: "crash-access-token" }));
        return;
      }

      const raw = Buffer.from((JSON.parse(body) as { raw: string }).raw, "base64url").toString("utf8");
      sends.push(/^Message-ID: (.+)$/m.exec(raw)?.[1]?.trim() ?? "?");
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: `provider-${sends.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sends };
}

async function environment() {
  const database = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  cleanups.push(() => database.dispose());
  await runMigrations({ databaseUrl: database.connectionString, direction: "up" });
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-delivery-crash-"));
  cleanups.push(() => fsPromises.rm(storageRoot, { recursive: true, force: true }));
  const admin = new pg.Client({ connectionString: database.connectionString });
  await admin.connect();
  cleanups.push(() => admin.end());
  const provider = await fakeProvider();
  const sql = async (text: string, values: unknown[] = []): Promise<AnyRecord[]> => (await admin.query(text, values)).rows;

  const env = {
    provider,
    sql,
    start: (options: Partial<ServiceProcessOptions> = {}): Promise<ServiceProcess> =>
      startServiceProcess(
        {
          databaseUrl: database.connectionString,
          storageRoot,
          syncBudgetMs: 10_000,
          registryJson: registryJson(),
          fakeMailProvider: provider.url,
          deliveryLeaseMs: DELIVERY_LEASE_MS,
          ...options
        },
        (cleanup) => cleanups.push(cleanup)
      ),
    /** Issue a quote through the service and queue one delivery; returns the ids. */
    async queue(service: ServiceProcess): Promise<{ quoteId: string; deliveryId: string }> {
      const headers = { Authorization: bearer(TOKEN), "Content-Type": "application/json" };
      const created = await fetch(`${service.baseUrl}/v2/quotes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": `issue-${crypto.randomUUID()}` },
        body: JSON.stringify(example("create-and-issue.request.json"))
      });
      const quoteId = ((await created.json()) as AnyRecord).quote.quoteId as string;
      await waitFor(async () => (await sql(`select status from quote_service.quotes where quote_id = $1`, [quoteId]))[0]?.status === "issued", 60_000, 100);
      const requested = await fetch(`${service.baseUrl}/v2/quotes/${quoteId}/deliveries/email`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": `delivery-${crypto.randomUUID()}` },
        body: JSON.stringify({ recipient: { email: "buyer@example.com", name: "Buyer" } })
      });
      expect(requested.status).toBe(202);
      return { quoteId, deliveryId: ((await requested.json()) as AnyRecord).deliveryId as string };
    },
    async row(deliveryId: string): Promise<AnyRecord> {
      return (await sql(`select *, generation::int as generation from quote_service.quote_deliveries where delivery_id = $1`, [deliveryId]))[0]!;
    },
    async waitStatus(deliveryId: string, status: string, timeoutMs = 45_000): Promise<void> {
      await waitFor(async () => (await env.row(deliveryId)).status === status, timeoutMs, 200);
    },
    expireLease: (deliveryId: string) =>
      sql(`update quote_service.quote_deliveries set lease_expires_at = clock_timestamp() - interval '1 second' where delivery_id = $1 and status = 'sending'`, [deliveryId]),
    async events(quoteId: string): Promise<string[]> {
      return (await sql(`select event_type from quote_service.quote_audit_events where quote_id = $1 and event_type like 'quote.delivery.%' order by sequence`, [quoteId])).map(
        (row) => row.event_type as string
      );
    }
  };

  return env;
}

describe("R1.6B real process kill: delivery crash matrix", () => {
  it(
    "BJ: crash after claim, before the provider call → the REAL lease expires → unknown; provider calls 0; restart never sends",
    async () => {
      const env = await environment();
      const a = await env.start({ deliveryHalt: "delivery_after_claim" });
      const { quoteId, deliveryId } = await env.queue(a);
      await a.waitFor((line) => line.event === "delivery_failpoint.reached");
      expect(await env.row(deliveryId)).toMatchObject({ status: "sending", generation: 1, attempt_count: 1 });
      expect(String((await env.row(deliveryId)).lease_owner)).toContain(`:${a.pid}:`);

      await a.kill();
      const b = await env.start();
      // Before expiry nobody may take it.
      await sleep(2_000);
      const during = await env.row(deliveryId);
      if (new Date(during.lease_expires_at as string).getTime() > Date.now() + 1_000) {
        expect(during).toMatchObject({ status: "sending", generation: 1 });
      }

      await env.waitStatus(deliveryId, "unknown", DELIVERY_LEASE_MS + 30_000);
      await sleep(2_000);
      expect(await env.row(deliveryId)).toMatchObject({ status: "unknown", generation: 2, last_error_code: "delivery_outcome_unknown", lease_owner: null, attempt_count: 1 });
      expect(env.provider.sends).toHaveLength(0);
      expect(await env.events(quoteId)).toEqual(["quote.delivery.requested", "quote.delivery.unknown"]);
      expect(b.events("delivery.outcome_unknown")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BK: crash after the provider accepted, before the DB completion → unknown after lease expiry; provider calls exactly 1; restart never resends",
    async () => {
      const env = await environment();
      const a = await env.start({ deliveryHalt: "delivery_after_provider_outcome" });
      const { quoteId, deliveryId } = await env.queue(a);
      await a.waitFor((line) => line.event === "delivery_failpoint.reached");
      expect(env.provider.sends).toEqual([`<delivery.${deliveryId}@pesaschile.cl>`]);
      expect((await env.row(deliveryId)).status).toBe("sending");

      await a.kill();
      await env.start();
      await env.expireLease(deliveryId);
      await env.waitStatus(deliveryId, "unknown");
      await sleep(3_000);
      expect(await env.row(deliveryId)).toMatchObject({ status: "unknown", generation: 2, sent_at: null });
      expect(env.provider.sends).toHaveLength(1);
      expect(await env.events(quoteId)).toEqual(["quote.delivery.requested", "quote.delivery.unknown"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BL: crash after the `sent` COMMIT, before the worker reported it → sent stays terminal; restart never resends",
    async () => {
      const env = await environment();
      const a = await env.start({ deliveryHalt: "delivery_after_completion" });
      const { quoteId, deliveryId } = await env.queue(a);
      await a.waitFor((line) => line.event === "delivery_failpoint.reached");
      expect(await env.row(deliveryId)).toMatchObject({ status: "sent", provider_message_id: "provider-1" });

      await a.kill();
      await env.start();
      await sleep(3_000);
      expect(await env.row(deliveryId)).toMatchObject({ status: "sent", generation: 1, attempt_count: 1 });
      expect(env.provider.sends).toHaveLength(1);
      expect(await env.events(quoteId)).toEqual(["quote.delivery.requested", "quote.delivery.sent"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "BM: worker accepted, then the sweep wins before its completion → the late result is fenced (delivery.late_result); unknown remains; provider calls 1",
    async () => {
      const env = await environment();
      const a = await env.start({ deliveryHalt: "delivery_after_provider_outcome" });
      const { quoteId, deliveryId } = await env.queue(a);
      await a.waitFor((line) => line.event === "delivery_failpoint.reached");
      expect(env.provider.sends).toHaveLength(1);

      // The holder is alive but stalled; its lease expires and the sweep (here A's own) resolves it.
      await env.expireLease(deliveryId);
      await env.waitStatus(deliveryId, "unknown");
      expect((await env.row(deliveryId)).generation).toBe(2);

      a.resume();
      const late = await a.waitFor((line) => line.event === "delivery.late_result");
      expect(late).toMatchObject({ deliveryId, generation: 1, outcome: "accepted", providerMessageId: "provider-1", currentStatus: "unknown" });
      await sleep(2_000);
      expect(await env.row(deliveryId)).toMatchObject({ status: "unknown", generation: 2, provider_message_id: null, sent_at: null });
      expect(env.provider.sends).toHaveLength(1);
      expect(await env.events(quoteId)).toEqual(["quote.delivery.requested", "quote.delivery.unknown"]);

      // No log line carries the recipient.
      expect(JSON.stringify(a.lines())).not.toContain("buyer@example.com");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "stop (SIGTERM; TerminateProcess on Windows) before a claim: the delivery stays pending and the next process sends it exactly once",
    async () => {
      const env = await environment();
      const a = await env.start({ deliveryPollIntervalMs: 60_000 });
      const { deliveryId } = await env.queue(a);
      await a.stop();
      expect((await env.row(deliveryId)).status).toBe("pending");

      await env.start();
      await env.waitStatus(deliveryId, "sent");
      await sleep(1_500);
      expect(env.provider.sends).toEqual([`<delivery.${deliveryId}@pesaschile.cl>`]);
    },
    TEST_TIMEOUT_MS
  );
});
