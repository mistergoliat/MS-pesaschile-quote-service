/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- HTTP bodies are untyped by nature */
import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/app";
import { CAPABILITIES, type Capability } from "../../src/application/health/dependency-monitor";
import type { MailSenderPort, MailSendOutcome } from "../../src/application/quote-v2/delivery/mail-sender-port";
import { responseErrors, schemaErrors } from "../helpers/openapi-contract";
import { clerkRegistry, example, freshCleanups, MONITORING_TOKEN, startHarness, type AnyRecord, type Harness } from "../helpers/r16d-harness";
import { buildRuntimeTestEnv } from "../helpers/runtime-test-env";

/*
 * R1.6D — capability-oriented readiness. Each business route declares the
 * one capability it needs (route config, like `requiredScope`); jobs are
 * gated the same way. `/health/ready` is unchanged: it still means "the full
 * issuance write path" with the frozen five checks.
 *
 * Outages are real monitor states: the renderer probe fails (assets
 * missing), the storage root is replaced by a plain file (volume gone), the
 * database proxy is closed. Nothing is stubbed inside the monitor.
 */

const TEST_TIMEOUT_MS = 180_000;
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  await run();
}, 60_000);

/** The exact route → capability matrix. A new route must be added here (and classified) or this suite fails. */
const ROUTE_CAPABILITIES: Record<string, Capability> = {
  "POST /v2/quotes": "ISSUANCE",
  "POST /v2/quotes/drafts": "PERSISTENCE",
  "PATCH /v2/quotes/:quoteId/draft": "PERSISTENCE",
  "POST /v2/quotes/:quoteId/issue": "ISSUANCE",
  "POST /v2/quotes/:quoteId/cancel": "PERSISTENCE",
  "GET /v2/quotes/:quoteId": "PERSISTENCE",
  "GET /v2/quotes": "PERSISTENCE",
  "GET /v2/quotes/:quoteId/document": "DOCUMENT_READ",
  "GET /v2/operations/:operationId": "PERSISTENCE",
  "GET /v2/quotes/:quoteId/audit": "PERSISTENCE",
  "GET /v2/idempotency/current": "PERSISTENCE",
  "POST /v2/quotes/:quoteId/deliveries/email": "DELIVERY_REQUEST",
  "GET /v2/quotes/:quoteId/deliveries/:deliveryId": "PERSISTENCE"
};

/** Fake provider (configured), failing every send as a provider outage would. */
class DownProvider implements MailSenderPort {
  calls = 0;
  send(): Promise<MailSendOutcome> {
    this.calls += 1;
    return Promise.resolve({ kind: "not_accepted", retryable: true, code: "email_provider_unavailable" as never });
  }
}

interface Fixture {
  readonly issued: AnyRecord;
  readonly draft: AnyRecord;
  readonly cancellable: AnyRecord;
  readonly issuableDraft: AnyRecord;
  readonly deliveryId: string;
}

async function fixture(harness: Harness): Promise<Fixture> {
  const issued = await harness.issued();
  const delivery = await harness.call("POST", `/v2/quotes/${issued.quoteId}/deliveries/email`, { key: `d-${crypto.randomUUID()}`, body: example("email-delivery.request.json") });
  expect(delivery.status).toBe(202);
  return { issued, draft: await harness.draft(), cancellable: await harness.draft(), issuableDraft: await harness.draft(), deliveryId: delivery.body.deliveryId as string };
}

/** One request per business route; returns status (and error) keyed by route. */
async function exercise(harness: Harness, f: Fixture): Promise<Record<string, { status: number; error?: AnyRecord }>> {
  const key = () => `k-${crypto.randomUUID()}`;
  const issueBody = { ...example("issue.request.json"), expectedVersion: f.issuableDraft.version as number };
  delete (issueBody as AnyRecord).expectedTotals;
  const requests: Record<string, () => ReturnType<Harness["call"]>> = {
    "POST /v2/quotes": () => harness.call("POST", "/v2/quotes", { key: key(), body: example("create-and-issue.request.json") }),
    "POST /v2/quotes/drafts": () => harness.call("POST", "/v2/quotes/drafts", { key: key(), body: example("draft-create.request.json") }),
    "PATCH /v2/quotes/:quoteId/draft": () =>
      harness.call("PATCH", `/v2/quotes/${f.draft.quoteId}/draft`, { key: key(), body: { ...example("draft-update.request.json"), expectedVersion: f.draft.version } }),
    "POST /v2/quotes/:quoteId/issue": () => harness.call("POST", `/v2/quotes/${f.issuableDraft.quoteId}/issue`, { key: key(), body: issueBody }),
    "POST /v2/quotes/:quoteId/cancel": () =>
      harness.call("POST", `/v2/quotes/${f.cancellable.quoteId}/cancel`, { key: key(), body: { expectedVersion: f.cancellable.version, reasonCode: "customer_declined" } }),
    "GET /v2/quotes/:quoteId": () => harness.call("GET", `/v2/quotes/${f.issued.quoteId}`),
    "GET /v2/quotes": () => harness.call("GET", `/v2/quotes?sourceSystem=${f.issued.externalCorrelation.sourceSystem as string}`),
    "GET /v2/quotes/:quoteId/document": () => harness.call("GET", `/v2/quotes/${f.issued.quoteId}/document`),
    "GET /v2/operations/:operationId": () => harness.call("GET", `/v2/operations/${f.issued.issuance.operationId as string}`),
    "GET /v2/quotes/:quoteId/audit": () => harness.call("GET", `/v2/quotes/${f.issued.quoteId}/audit`),
    "GET /v2/idempotency/current": () => harness.call("GET", "/v2/idempotency/current?operation=quote.create_and_issue", { headers: { "Idempotency-Key": key() } }),
    "POST /v2/quotes/:quoteId/deliveries/email": () =>
      harness.call("POST", `/v2/quotes/${f.issued.quoteId}/deliveries/email`, { key: key(), body: example("email-delivery.request.json") }),
    "GET /v2/quotes/:quoteId/deliveries/:deliveryId": () => harness.call("GET", `/v2/quotes/${f.issued.quoteId}/deliveries/${f.deliveryId}`)
  };
  const results: Record<string, { status: number; error?: AnyRecord }> = {};

  for (const [route, send] of Object.entries(requests)) {
    const response = await send();
    results[route] = response.status >= 400 ? { status: response.status, error: response.body?.error as AnyRecord } : { status: response.status };
  }

  return results;
}

async function tempRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-r16d-routes-"));
  cleanups.push(() => fsPromises.rm(root, { recursive: true, force: true }));
  return root;
}

const statuses = (results: Record<string, { status: number }>) => Object.fromEntries(Object.entries(results).map(([route, result]) => [route, result.status]));

/** Healthy answers per route (an unbound idempotency lookup is a 200 "not found" body by contract). */
const HEALTHY: Record<string, number> = {
  "POST /v2/quotes": 201,
  "POST /v2/quotes/drafts": 201,
  "PATCH /v2/quotes/:quoteId/draft": 200,
  "POST /v2/quotes/:quoteId/issue": 200,
  "POST /v2/quotes/:quoteId/cancel": 200,
  "GET /v2/quotes/:quoteId": 200,
  "GET /v2/quotes": 200,
  "GET /v2/quotes/:quoteId/document": 200,
  "GET /v2/operations/:operationId": 200,
  "GET /v2/quotes/:quoteId/audit": 200,
  "GET /v2/idempotency/current": 200,
  "POST /v2/quotes/:quoteId/deliveries/email": 202,
  "GET /v2/quotes/:quoteId/deliveries/:deliveryId": 200
};

function expected(blocked: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(HEALTHY).map(([route, status]) => [route, route in blocked ? 503 : status]));
}

function gates(harness: Harness): Record<Capability, unknown> {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, harness.monitor.gate(capability)])) as Record<Capability, unknown>;
}

describe("route capability declaration (57)", () => {
  it("every V2 business route declares exactly the expected capability", async () => {
    const context = buildApplication(buildRuntimeTestEnv({ databaseUrl: "postgres://u:p@127.0.0.1:1/none", storageRoot: await tempRoot() }), { principalRegistry: clerkRegistry() });
    const seen: Record<string, unknown> = {};
    context.app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (route.url.startsWith("/v2") && method !== "HEAD") {
          seen[`${method} ${route.url}`] = route.config?.capability;
        }
      }
    });
    cleanups.push(() => context.app.close());
    await context.app.ready();

    expect(seen).toEqual(ROUTE_CAPABILITIES);
  }, TEST_TIMEOUT_MS);

  it("a business route without a declared capability fails registration (startup)", async () => {
    const context = buildApplication(buildRuntimeTestEnv({ databaseUrl: "postgres://u:p@127.0.0.1:1/none", storageRoot: await tempRoot() }), {
      principalRegistry: clerkRegistry(),
      businessRoutes: [(app) => app.get("/probe/unclassified", { config: { requiredScope: "quotes:read" } }, () => ({}))]
    });
    cleanups.push(() => context.app.close().catch(() => undefined));

    await expect(context.app.ready()).rejects.toThrow(/declares no capability/);
  }, TEST_TIMEOUT_MS);
});

describe("capability degradation matrix (A-F)", () => {
  it("A: all dependencies healthy → every route works; every capability is open", async () => {
    const harness = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const results = await exercise(harness, await fixture(harness));

    expect(statuses(results)).toEqual(HEALTHY);
    expect(Object.values(gates(harness)).every((gate) => gate === null)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("B: renderer down → reads, document, drafts, cancel and delivery work; only issuance is 503 renderer", async () => {
    const harness = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const f = await fixture(harness);
    await harness.rendererDown(true);

    const ready = await harness.call("GET", "/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "not_ready", checks: { database: "ok", schema: "ok", artifactStorage: "ok", renderer: "fail", lifecycle: "ok" } });

    const results = await exercise(harness, f);
    expect(statuses(results)).toEqual(expected({ "POST /v2/quotes": "", "POST /v2/quotes/:quoteId/issue": "" }));
    for (const route of ["POST /v2/quotes", "POST /v2/quotes/:quoteId/issue"]) {
      expect(results[route]!.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "renderer", retryable: true } });
    }
    const renderer = { code: "dependency_unavailable", dependency: "renderer" };
    expect(gates(harness)).toEqual({ PERSISTENCE: null, DOCUMENT_READ: null, ISSUANCE: renderer, DELIVERY_REQUEST: null, DELIVERY_SEND: null, DEADLINE_SWEEP: null });
    // Jobs: issuance pauses; every other job keeps running.
    expect(harness.monitor.canRun("ISSUANCE")).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("C: storage down → ordinary reads, drafts, cancel and delivery requests work; document and issuance are 503 artifactStorage", async () => {
    const harness = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const f = await fixture(harness);
    await harness.storageDown(true);

    const results = await exercise(harness, f);
    expect(statuses(results)).toEqual(expected({ "POST /v2/quotes": "", "POST /v2/quotes/:quoteId/issue": "", "GET /v2/quotes/:quoteId/document": "" }));
    for (const route of ["POST /v2/quotes", "POST /v2/quotes/:quoteId/issue", "GET /v2/quotes/:quoteId/document"]) {
      expect(results[route]!.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "artifactStorage" } });
    }
    const storage = { code: "dependency_unavailable", dependency: "artifactStorage" };
    expect(gates(harness)).toEqual({ PERSISTENCE: null, DOCUMENT_READ: storage, ISSUANCE: storage, DELIVERY_REQUEST: null, DELIVERY_SEND: storage, DEADLINE_SWEEP: null });
  }, TEST_TIMEOUT_MS);

  it("D: database down → every business route 503 database, liveness 200, no worker mutation", async () => {
    const harness = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const f = await fixture(harness);
    const before = await harness.sql(`select quote_id, status, version from quote_service.quotes order by quote_id`);
    await harness.databaseDown(true);

    const results = await exercise(harness, f);
    expect(statuses(results)).toEqual(expected(Object.fromEntries(Object.keys(HEALTHY).map((route) => [route, ""]))));
    for (const result of Object.values(results)) {
      expect(result.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "database" } });
    }
    expect((await harness.call("GET", "/health/live", { token: null })).status).toBe(200);
    expect((await harness.call("GET", "/health/ready", { token: null })).status).toBe(503);
    expect(CAPABILITIES.every((capability) => !harness.monitor.canRun(capability))).toBe(true);

    for (const name of ["issuance", "issuanceDeadlineSweep", "expiry", "deliveryOutcomeSweep", "emailDelivery"] as const) {
      expect(harness.context.backgroundJobs.status()[name].enabled, name).toBe(true);
    }
    await harness.context.expiry.runner.runNow();
    await harness.context.issuance!.issuanceDeadlineSweep.runNow();
    await harness.context.delivery!.deliveryOutcomeSweep.runNow();
    expect(await harness.sql(`select quote_id, status, version from quote_service.quotes order by quote_id`)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it("E: email provider configured but failing → readiness, quote and document reads unaffected; requests still queue (202)", async () => {
    const provider = new DownProvider();
    const harness = await startHarness({ cleanups, overrides: { testMailSender: provider } });
    const f = await fixture(harness);
    await harness.context.delivery!.worker!.tick();
    expect(provider.calls).toBe(1);
    const health = await harness.health();
    expect(responseErrors("/health/dependencies", "get", 200, health)).toEqual([]);
    expect(health.dependencies.emailProvider.status).toBe("down");

    expect((await harness.call("GET", "/health/ready", { token: null })).status).toBe(200);
    expect(statuses(await exercise(harness, f))).toEqual(HEALTHY);
    // A previous provider failure is not a gate: the send runner may still run (and classify the next outcome itself).
    expect(harness.monitor.canRun("DELIVERY_SEND")).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("F: email provider disabled → new key 503 email_provider; a bound key still replays first (A6)", async () => {
    const enabled = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const quote = await enabled.issued();
    const key = `bound-${crypto.randomUUID()}`;
    const first = await enabled.call("POST", `/v2/quotes/${quote.quoteId}/deliveries/email`, { key, body: example("email-delivery.request.json") });
    expect(first.status).toBe(202);

    const disabled = await startHarness({ cleanups, databaseUrl: enabled.databaseUrl, storageRoot: enabled.storageRoot });
    const replay = await disabled.call("POST", `/v2/quotes/${quote.quoteId}/deliveries/email`, { key, body: example("email-delivery.request.json") });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.deliveryId).toBe(first.body.deliveryId);

    const fresh = await disabled.call("POST", `/v2/quotes/${quote.quoteId}/deliveries/email`, { key: `new-${crypto.randomUUID()}`, body: example("email-delivery.request.json") });
    expect(fresh.status).toBe(503);
    expect(fresh.body.error).toMatchObject({ code: "dependency_unavailable", details: { dependency: "email_provider", retryable: false } });
    expect((await disabled.call("GET", "/health/ready", { token: null })).status).toBe(200);
    expect((await disabled.call("GET", `/v2/quotes/${quote.quoteId}/document`)).status).toBe(200);
  }, TEST_TIMEOUT_MS);
});

describe("/health/ready regression (58)", () => {
  it("schema, checks and rules are unchanged: renderer and storage affect it, email never does, no capability fields", async () => {
    const harness = await startHarness({ cleanups, overrides: { testMailSender: new DownProvider() } });
    const read = async () => {
      const response = await harness.call("GET", "/health/ready", { token: null });
      expect(schemaErrors("Readiness", response.body)).toEqual([]);
      expect(Object.keys(response.body as object).sort()).toEqual(["checks", "status"]);
      expect(Object.keys(response.body.checks as object).sort()).toEqual(["artifactStorage", "database", "lifecycle", "renderer", "schema"]);
      expect(response.text).not.toMatch(/PERSISTENCE|DOCUMENT_READ|ISSUANCE|DELIVERY|capabilit|email/i);
      return response;
    };

    expect((await read()).status).toBe(200);

    const quote = await harness.issued();
    await harness.call("POST", `/v2/quotes/${quote.quoteId}/deliveries/email`, { key: `d-${crypto.randomUUID()}`, body: example("email-delivery.request.json") });
    await harness.context.delivery!.worker!.tick();
    expect((await read()).status).toBe(200);

    await harness.rendererDown(true);
    expect((await read()).body).toEqual({ status: "not_ready", checks: { database: "ok", schema: "ok", artifactStorage: "ok", renderer: "fail", lifecycle: "ok" } });
    await harness.rendererDown(false);
    await harness.storageDown(true);
    expect((await read()).body).toEqual({ status: "not_ready", checks: { database: "ok", schema: "ok", artifactStorage: "fail", renderer: "ok", lifecycle: "ok" } });
    await harness.storageDown(false);
    expect((await read()).status).toBe(200);

    // Health detail stays contract-shaped (workers keys frozen; no capability names).
    const health = await harness.call("GET", "/health/dependencies", { token: MONITORING_TOKEN });
    expect(responseErrors("/health/dependencies", "get", 200, health.body)).toEqual([]);
    expect(Object.keys(health.body.workers as object).sort()).toEqual(["emailDelivery", "expiry", "issuance"]);
  }, TEST_TIMEOUT_MS);
});
