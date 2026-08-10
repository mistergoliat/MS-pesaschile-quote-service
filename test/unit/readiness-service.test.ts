import { describe, expect, it } from "vitest";

import { ReadinessService } from "../../src/application/health/readiness-service";

describe("ReadinessService", () => {
  it("returns not_ready when the database dependency is down", async () => {
    const service = new ReadinessService(
      {
        checkHealth() {
          return Promise.resolve({
            status: "down",
            latencyMs: 12
          } as const);
        }
      },
      {
        checkReadiness() {
          return Promise.resolve({
            status: "up"
          } as const);
        }
      },
      {
        checkReadiness() {
          return Promise.resolve({
            status: "up"
          } as const);
        }
      },
      {
        isShuttingDown: false
      },
      {
        serviceName: "pesaschile-quote-service",
        serviceVersion: "0.1.0-test",
        databaseTimeoutMs: 1000
      }
    );

    const result = await service.check(new Date("2026-08-10T18:00:00.000Z"));

    expect(result).toMatchObject({
      status: "not_ready",
      checks: {
        lifecycle: {
          status: "up"
        },
        database: {
          status: "down"
        },
        storage: {
          status: "up"
        },
        pdfRenderer: {
          status: "up"
        }
      }
    });
  });
});
