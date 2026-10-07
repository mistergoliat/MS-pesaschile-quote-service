/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any) are typed any */

import { afterEach, describe, expect, it } from "vitest";

import { schemaErrors } from "../helpers/openapi-contract";
import { CLERK_TOKEN, freshCleanups, startHarness, type Harness } from "../helpers/r16d-harness";

/*
 * R1.6D — V1 HTTP retirement (Domain §12 `api_version_retired`, V1
 * migration §"Retired"). Every `/v1` path answers `410` with the frozen error
 * envelope, whatever the method, body, credential or dependency state; the
 * contract asks for no authentication to learn that a version is gone.
 * Code only: going live with it is the R1.7 cutover.
 */

const TEST_TIMEOUT_MS = 90_000;
const { cleanups, run } = freshCleanups();

afterEach(async () => {
  await run();
}, 60_000);

const PATHS = ["/v1", "/v1/", "/v1/quotes", "/v1/quotes/10000000-0000-4000-8000-000000000002/issue", "/v1/anything/nested/deep?x=1", "/v1/documents/sha256:abc"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

async function expectRetired(harness: Harness, method: string, pathname: string, init: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<void> {
  const response = await harness.call(method, pathname, { token: null, ...init });
  const label = `${method} ${pathname}`;

  expect(response.status, label).toBe(410);
  expect(response.headers.get("content-type"), label).toMatch(/^application\/json/);
  expect(response.body, label).toEqual({ error: { code: "api_version_retired", message: expect.any(String), requestId: expect.any(String) } });
  expect(schemaErrors("ErrorResponse", response.body), label).toEqual([]);
}

describe("V1 retirement (AP-AW)", () => {
  it("AP-AT/AW: every method on every /v1 path answers 410 api_version_retired (frozen envelope), unauthenticated", async () => {
    const harness = await startHarness({ cleanups });

    for (const pathname of PATHS) {
      for (const method of METHODS) {
        await expectRetired(harness, method, pathname, method === "POST" || method === "PUT" || method === "PATCH" ? { body: { any: "v1 body" } } : {});
      }

      const head = await harness.call("HEAD", pathname, { token: null });
      expect(head.status, `HEAD ${pathname}`).toBe(410);
    }
  }, TEST_TIMEOUT_MS);

  it("410 wins over credentials, malformed or oversized bodies, unsupported media types and dependency outages", async () => {
    const harness = await startHarness({ cleanups });

    await expectRetired(harness, "POST", "/v1/quotes", { token: "not-a-valid-token" });
    await expectRetired(harness, "POST", "/v1/quotes", { token: CLERK_TOKEN });
    await expectRetired(harness, "POST", "/v1/quotes", { body: "{not json", headers: { "Content-Type": "application/json" } });
    await expectRetired(harness, "POST", "/v1/quotes", { body: "x".repeat(2 * 1024 * 1024) });
    await expectRetired(harness, "POST", "/v1/quotes", { body: "<xml/>", headers: { "Content-Type": "application/xml" } });

    await harness.databaseDown(true);
    await harness.rendererDown(true);
    await expectRetired(harness, "GET", "/v1/quotes");
  }, TEST_TIMEOUT_MS);

  it("AU/AV: /v10, /v11 and /v1x are not caught; /v2 is unchanged", async () => {
    const harness = await startHarness({ cleanups });

    for (const pathname of ["/v10", "/v10/quotes", "/v11/quotes", "/v1x", "/v1quotes"]) {
      expect((await harness.call("GET", pathname, { token: null })).status, pathname).toBe(404);
    }

    expect((await harness.call("GET", "/v2/quotes?sourceSystem=crm", { token: null })).status).toBe(401);
    expect((await harness.call("GET", "/v2/quotes?sourceSystem=crm")).status).toBe(200);
    const quote = await harness.issued();
    expect((await harness.call("GET", `/v2/quotes/${quote.quoteId as string}`)).status).toBe(200);
  }, TEST_TIMEOUT_MS);
});
