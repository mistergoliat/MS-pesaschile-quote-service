/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- HTTP bodies are untyped by nature */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { GmailMailSender } from "../../src/infrastructure/email/gmail-mail-sender";
import { example, freshCleanups, startHarness, type AnyRecord } from "../helpers/r16d-harness";

/*
 * R1.6D — hostile redaction. Unique sentinels are pushed through the real
 * runtime composition (HTTP auth, idempotency, create/draft/issue/cancel,
 * validation failures, delivery with the REAL Gmail adapter against a
 * loopback fake provider, both workers, expiry and the integrity scan, an
 * unexpected 500 carrying a driver-style `detail`, a database outage, and an
 * operator CLI failure). None of the exact sentinel strings may appear in
 * any captured log line; client error surfaces carry no stack, path, DSN,
 * provider text or secret. Nothing reaches Gmail or the internet.
 */

const TEST_TIMEOUT_MS = 180_000;
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  await run();
}, 60_000);

const tag = crypto.randomBytes(4).toString("hex");
const digits = String(crypto.randomInt(10_000_000, 99_999_999));
const S = {
  authorization: `SENTINEL-AUTH-${tag}-0123456789abcdefghijklmnopqrstuv`,
  accessToken: `SENTINEL-ACCESS-${tag}`,
  refreshToken: `SENTINEL-REFRESH-${tag}`,
  clientSecret: `SENTINEL-GMAIL-SECRET-${tag}`,
  idempotencyKey: `SENTINEL-IDEMKEY-${tag}`,
  recipient: `sentinel-recipient-${tag}@example.com`,
  recipientName: `Sentinel Destinatario ${tag}`,
  providerBody: `SENTINEL-PROVIDER-BODY-${tag}`,
  customerName: `Sentinel Cliente ${tag}`,
  customerEmail: `sentinel-customer-${tag}@example.com`,
  customerPhone: `+56 9 ${digits.slice(0, 4)} ${digits.slice(4)}`,
  commercialText: `Sentinel Mancuerna Comercial ${tag}`,
  driverDetail: `SENTINEL-DRIVER-DETAIL-${tag}`,
  dbPassword: `SENTINELPASS${tag}`
} as const;

function hostileCreateBody(): AnyRecord {
  const body = example("create-and-issue.request.json");
  body.customer = { ...body.customer, displayName: S.customerName, email: S.customerEmail, phone: S.customerPhone };
  body.lines[0].item.description = S.commercialText;
  return body;
}

describe("hostile log redaction (AX-BH)", () => {
  it("no sentinel reaches any runtime log line; client error surfaces stay sanitized", async () => {
    // Loopback fake Gmail: a token grant, then 400 / 503 / 200 sends whose bodies echo the sentinels.
    let sends = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/token") {
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: S.accessToken }));
          return;
        }

        sends += 1;
        const status = sends === 1 ? 400 : sends === 2 ? 503 : 200;
        response
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(status === 200 ? { id: "provider-id" } : { error: { message: `${S.providerBody} ${S.recipient} ${S.accessToken}` } }));
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sender = new GmailMailSender({
      clientId: "client-id",
      clientSecret: S.clientSecret,
      refreshToken: S.refreshToken,
      from: { address: "cotizaciones@pesaschile.cl", name: "Pesas Chile" },
      replyTo: null,
      tokenTimeoutMs: 1_000,
      sendTimeoutMs: 2_000,
      endpoints: { token: `${base}/token`, send: `${base}/send` }
    });

    const logs: string[] = [];
    const harness = await startHarness({
      cleanups,
      logs,
      env: { QUOTE_INTEGRITY_CHECK_INTERVAL_MS: "3600000" },
      overrides: {
        testMailSender: sender,
        // An unexpected failure whose message and driver-style `detail` echo row values.
        businessRoutes: [
          (app) =>
            app.get("/probe/explode", { config: { requiredScope: "quotes:read", capability: "PERSISTENCE" } }, () => {
              throw Object.assign(new Error(`boom ${S.driverDetail}`), { detail: `Failing row contains (${S.customerName}, ${S.driverDetail})`, code: "23514" });
            })
        ]
      }
    });
    const clientSurfaces: string[] = [];
    const record = <T extends { text: string }>(response: T): T => {
      clientSurfaces.push(response.text);
      return response;
    };

    // AX: an invalid credential and a valid one with a hostile key.
    expect(record(await harness.call("GET", "/v2/quotes?sourceSystem=crm", { token: S.authorization })).status).toBe(401);
    // BB/BF/BG: create-and-issue with PII and commercial text, then replay and conflict with the same raw key.
    const created = record(await harness.call("POST", "/v2/quotes", { key: S.idempotencyKey, body: hostileCreateBody() }));
    expect(created.status).toBe(201);
    const quoteId = created.body.quote.quoteId as string;
    expect(record(await harness.call("POST", "/v2/quotes", { key: S.idempotencyKey, body: hostileCreateBody() })).status).toBe(201);
    expect(record(await harness.call("POST", "/v2/quotes", { key: S.idempotencyKey, body: { ...hostileCreateBody(), lines: [] } })).status).toBe(409);
    // 422 with PII in the rejected body.
    const invalid = hostileCreateBody();
    invalid.customer.rut = `${S.customerName}-K`;
    expect(record(await harness.call("POST", "/v2/quotes", { key: `${S.idempotencyKey}-2`, body: invalid })).status).toBe(422);
    expect(record(await harness.call("GET", `/v2/idempotency/current?operation=quote.create_and_issue`, { headers: { "Idempotency-Key": S.idempotencyKey } })).status).toBe(200);
    expect(record(await harness.call("GET", `/v2/quotes/${quoteId}`)).status).toBe(200);
    expect(record(await harness.call("GET", `/v2/quotes/${quoteId}/audit`)).status).toBe(200);
    expect((await harness.call("GET", `/v2/quotes/${quoteId}/document`)).status).toBe(200);

    // BC/BD/BE/AY/AZ/BA: three deliveries through the real Gmail adapter (permanent, ambiguous, sent).
    for (let index = 0; index < 3; index += 1) {
      const delivery = record(
        await harness.call("POST", `/v2/quotes/${quoteId}/deliveries/email`, {
          key: `${S.idempotencyKey}-delivery-${index}`,
          body: { recipient: { email: S.recipient, name: S.recipientName } }
        })
      );
      expect(delivery.status).toBe(202);
      await harness.context.delivery!.worker!.tick();
    }
    expect(sends).toBe(3);

    // Jobs: expiry and the integrity scan over the hostile quote.
    await harness.pastValidity(quoteId);
    await harness.context.expiry.runner.runNow();
    await harness.context.documentIntegrity!.runNow();

    // BH: an unexpected 500 and a database outage answer sanitized envelopes.
    const explode = record(await harness.call("GET", "/probe/explode"));
    expect(explode.status).toBe(500);
    expect(explode.body).toEqual({ error: { code: "internal_error", message: "Unexpected server error", requestId: expect.any(String) } });
    await harness.databaseDown(true);
    const outage = record(await harness.call("GET", `/v2/quotes/${quoteId}`));
    expect(outage.status).toBe(503);
    await harness.databaseDown(false);

    const output = logs.join("\n");
    // The run really produced the events we inspected.
    for (const event of ["delivery.sent", "delivery.failed", "delivery.outcome_unknown", "expiry.materialized", "document.integrity_scan_completed"]) {
      expect(output, event).toContain(`"event":"${event}"`);
    }
    expect(output).toContain('"msg":"Unexpected request failure"');

    for (const [name, value] of Object.entries(S)) {
      expect(output, `log leaks ${name}`).not.toContain(value);
    }
    expect(output).not.toContain(S.recipient.split("@")[0]);

    const surfaces = clientSurfaces.join("\n");
    for (const value of [S.authorization, S.accessToken, S.refreshToken, S.clientSecret, S.providerBody, S.driverDetail, S.idempotencyKey, S.dbPassword]) {
      expect(surfaces).not.toContain(value);
    }
    // No stack frames, absolute paths or connection strings on any client surface.
    expect(surfaces).not.toMatch(/\bat [\w.<>]+ \(|node:internal|[A-Z]:\\|\/home\/|\/tmp\/|postgres:\/\/|127\.0\.0\.1:\d+\/quote_service/);
  }, TEST_TIMEOUT_MS);

  it("BH: an operator CLI failure reports a category only (no DSN, password, stack or path)", async () => {
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      let output = "";
      const child = spawn(process.execPath, ["--import", "tsx", "src/scripts/verify-document-artifacts.ts"], {
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "MIGRATION_DATABASE_URL")),
          DATABASE_URL: `postgres://quote_user:${S.dbPassword}@127.0.0.1:1/quote_service`,
          QUOTE_DOCUMENT_STORAGE_ROOT: "/var/lib/sentinel-storage"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.on("exit", (code) => resolve({ code, output }));
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.output.trim())).toEqual({ status: "failed", errorName: expect.any(String) });
    expect(result.output).not.toContain(S.dbPassword);
    expect(result.output).not.toMatch(/postgres:\/\/|sentinel-storage|\bat [\w.<>]+ \(|node:internal/);
  }, TEST_TIMEOUT_MS);
});
