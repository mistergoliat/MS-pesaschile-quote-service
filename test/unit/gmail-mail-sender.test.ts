import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { OutboundMail } from "../../src/application/quote-v2/delivery/mail-sender-port";
import { GmailMailSender, isProvenPreTransmissionFailure, type GmailMailSenderConfig } from "../../src/infrastructure/email/gmail-mail-sender";

/*
 * R1.6B §63: Gmail adapter outcome classification. Every provider here is a
 * local fake (an injected fetch or a loopback HTTP server); nothing reaches
 * Google or the internet.
 */

const SECRETS = {
  clientSecret: "client-secret-SHOULD-NEVER-LEAK-0001",
  refreshToken: "refresh-token-SHOULD-NEVER-LEAK-0002",
  accessToken: "access-token-SHOULD-NEVER-LEAK-0003"
};

const MAIL: OutboundMail = {
  deliveryId: "0b7f3c2e-9a41-4d6b-8f20-3c1d2e4f5a6b",
  to: "camila.rojas@example.com",
  subject: "Cotización Pesas Chile PC-000123",
  html: "<p>Hola</p>",
  attachments: [{ filename: "PC-000123.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7 test") }],
  inlineAssets: []
};

type Step = (url: string, init: RequestInit) => Promise<Response>;

function sender(steps: { token: Step; send?: Step }, overrides: Partial<GmailMailSenderConfig> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });

    if (url.includes("token")) {
      return steps.token(url, init ?? {});
    }

    if (!steps.send) {
      throw new Error("send must not be called");
    }

    return steps.send(url, init ?? {});
  }) as typeof fetch;

  return {
    calls,
    adapter: new GmailMailSender({
      clientId: "client-id",
      clientSecret: SECRETS.clientSecret,
      refreshToken: SECRETS.refreshToken,
      from: { address: "cotizaciones@pesaschile.cl", name: "Pesas Chile" },
      replyTo: "ventas@pesaschile.cl",
      tokenTimeoutMs: 200,
      sendTimeoutMs: 200,
      fetch: fetchImpl,
      ...overrides
    })
  };
}

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const tokenOk: Step = () => json(200, { access_token: SECRETS.accessToken, expires_in: 3599 });
const hang: Step = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
  });
const networkError = (code: string): Step => () => {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return Promise.reject(new TypeError("fetch failed", { cause }));
};

describe("R1.6B Gmail adapter: token phase (W5: never sent, always retryable)", () => {
  it("A: OAuth success + send 2xx with id → accepted with the provider id", async () => {
    const { adapter, calls } = sender({ token: tokenOk, send: () => json(200, { id: "18c2f0a1b2c3d4e5", threadId: "t" }) });
    expect(await adapter.send(MAIL)).toEqual({ kind: "accepted", providerMessageId: "18c2f0a1b2c3d4e5" });
    expect(calls).toHaveLength(2);
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRETS.accessToken}`);
  });

  it("B: send 2xx without an id (or with an unreadable body) → accepted, providerMessageId null", async () => {
    for (const send of [() => json(200, {}), () => Promise.resolve(new Response("not json", { status: 200 })), () => Promise.resolve(new Response(null, { status: 204 }))] as Step[]) {
      expect(await sender({ token: tokenOk, send }).adapter.send(MAIL)).toEqual({ kind: "accepted", providerMessageId: null });
    }
  });

  it("C: OAuth timeout → not_accepted retryable, send never called", async () => {
    const { adapter, calls } = sender({ token: hang });
    expect(await adapter.send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_provider_unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("D: OAuth invalid_grant → not_accepted retryable (credential repair takes effect on the same delivery)", async () => {
    const { adapter, calls } = sender({ token: () => json(400, { error: "invalid_grant", error_description: `Token has been expired or revoked ${SECRETS.refreshToken}` }) });
    expect(await adapter.send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_authentication_failed" });
    expect(calls).toHaveLength(1);
  });

  it("E: OAuth 401/403 → not_accepted retryable; 5xx, 429 and network errors too", async () => {
    for (const status of [401, 403]) {
      expect(await sender({ token: () => json(status, { error: "unauthorized_client" }) }).adapter.send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_authentication_failed" });
    }

    expect(await sender({ token: () => json(429, {}) }).adapter.send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_rate_limited" });

    for (const token of [() => json(500, {}), () => json(503, {}), networkError("ECONNRESET"), networkError("ENOTFOUND"), () => json(200, {})] as Step[]) {
      const { adapter, calls } = sender({ token });
      expect(await adapter.send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_provider_unavailable" });
      expect(calls).toHaveLength(1);
    }
  });
});

describe("R1.6B Gmail adapter: send phase (A6.3: only provably-not-accepted outcomes may retry)", () => {
  const outcome = async (send: Step) => sender({ token: tokenOk, send }).adapter.send(MAIL);

  it("F: send 429 → not_accepted retryable (explicit rate limit); 403 rate-limit reasons too", async () => {
    expect(await outcome(() => json(429, { error: { code: 429 } }))).toEqual({ kind: "not_accepted", retryable: true, code: "email_rate_limited" });
    expect(await outcome(() => json(403, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }))).toEqual({
      kind: "not_accepted",
      retryable: true,
      code: "email_rate_limited"
    });
  });

  it("send 401/403 (rejected before acceptance) → not_accepted retryable under W5", async () => {
    expect(await outcome(() => json(401, { error: { code: 401 } }))).toEqual({ kind: "not_accepted", retryable: true, code: "email_authentication_failed" });
    expect(await outcome(() => json(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }))).toEqual({
      kind: "not_accepted",
      retryable: true,
      code: "email_authentication_failed"
    });
  });

  it("G/H: send 400, 413, 422 (and other definitive rejections) → not_accepted permanent", async () => {
    for (const status of [400, 404, 405, 413, 414, 415, 422]) {
      expect(await outcome(() => json(status, { error: { code: status, message: `Invalid To header ${MAIL.to}` } })), String(status)).toEqual({
        kind: "not_accepted",
        retryable: false,
        code: "email_provider_rejected"
      });
    }
  });

  it("I/J: send 500, 502, 503, 504 → ambiguous (never retried)", async () => {
    for (const status of [500, 502, 503, 504]) {
      expect(await outcome(() => json(status, { error: { code: status } })), String(status)).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    }
  });

  it("408, redirects and unknown statuses → ambiguous", async () => {
    for (const status of [301, 302, 408, 409, 418, 499]) {
      expect(await outcome(() => Promise.resolve(new Response("", { status }))), String(status)).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    }
  });

  it("K: send timeout → ambiguous", async () => {
    expect(await outcome(hang)).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
  });

  it("L: reset / socket close after dispatch → ambiguous", async () => {
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
      expect(await outcome(networkError(code)), code).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    }
  });

  it("M: DNS / refused / unreachable / connect timeout / TLS validation proven by errno → not_accepted retryable", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(await outcome(networkError(code)), code).toEqual({ kind: "not_accepted", retryable: true, code: "email_provider_unavailable" });
    }
  });

  it("N: unclassifiable send failures (no typed code, message-only, mixed reset) → ambiguous", async () => {
    const failures: unknown[] = [
      new TypeError("fetch failed"),
      new TypeError("getaddrinfo ENOTFOUND gmail.googleapis.com"), // message text is never trusted
      new Error("weird"),
      Object.assign(new Error("x"), { code: "ECONNREFUSED", cause: Object.assign(new Error("y"), { code: "ECONNRESET" }) }),
      // A timeout never proves "not transmitted", whatever the cause chain says.
      Object.assign(new Error("timeout"), { name: "TimeoutError", cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }) }),
      Object.assign(new Error("aborted"), { name: "AbortError", code: "ECONNREFUSED" })
    ];

    for (const failure of failures) {
      expect(await outcome(() => Promise.reject(failure as Error))).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    }

    expect(isProvenPreTransmissionFailure(new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }) }))).toBe(true);
    expect(isProvenPreTransmissionFailure(null)).toBe(false);
  });

  it("an invalid message is refused before any network call (not_accepted permanent)", async () => {
    const { adapter, calls } = sender({ token: tokenOk, send: () => json(200, { id: "x" }) });
    expect(await adapter.send({ ...MAIL, to: "a>,<victim@evil.com" })).toEqual({ kind: "not_accepted", retryable: false, code: "email_message_invalid" });
    expect(await adapter.send({ ...MAIL, subject: "x\r\nBcc: victim@evil.com" })).toEqual({ kind: "not_accepted", retryable: false, code: "email_message_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("O: no provider body, token or address escapes through the outcome or an exception", async () => {
    const hostileBody = { error: { code: 400, message: `${SECRETS.accessToken} ${SECRETS.refreshToken} ${MAIL.to}`, errors: [{ reason: "invalid", message: MAIL.to }] } };
    const outcomes = [
      await outcome(() => json(400, hostileBody)),
      await outcome(() => json(500, hostileBody)),
      await sender({ token: () => json(400, { error: "invalid_grant", error_description: SECRETS.refreshToken }) }).adapter.send(MAIL)
    ];
    const serialized = JSON.stringify(outcomes);

    for (const secret of [...Object.values(SECRETS), MAIL.to, "client-id"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("R1.6B Gmail adapter: real loopback sockets (no internet)", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })
      )
    );
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function real(endpoints: { token: string; send: string }, sendTimeoutMs = 2_000) {
    return new GmailMailSender({
      clientId: "client-id",
      clientSecret: SECRETS.clientSecret,
      refreshToken: SECRETS.refreshToken,
      from: { address: "cotizaciones@pesaschile.cl", name: "Pesas Chile" },
      replyTo: null,
      tokenTimeoutMs: 2_000,
      sendTimeoutMs,
      endpoints
    });
  }

  it("connection refused on send (closed port) → not_accepted retryable; reset after the request was received → ambiguous", async () => {
    const token = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: SECRETS.accessToken }));
    });
    const closed = await serve(() => undefined);
    const closedUrl = `${closed}/send`;
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await real({ token: `${token}/token`, send: closedUrl }).send(MAIL)).toEqual({ kind: "not_accepted", retryable: true, code: "email_provider_unavailable" });

    let received = 0;
    const resetting = await serve((req) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        received += 1;
        req.socket.destroy();
      });
    });
    expect(await real({ token: `${token}/token`, send: `${resetting}/send` }).send(MAIL)).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    expect(received).toBe(1);
  });

  it("a send that never answers is cut by the send timeout → ambiguous", async () => {
    const token = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: SECRETS.accessToken }));
    });
    const silent = await serve(() => undefined);
    const started = Date.now();
    expect(await real({ token: `${token}/token`, send: `${silent}/send` }, 300).send(MAIL)).toEqual({ kind: "ambiguous", code: "email_outcome_unknown" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
