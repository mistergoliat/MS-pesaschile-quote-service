import { describe, expect, it } from "vitest";

import { PeriodicJobRunner } from "../../src/infrastructure/runtime/periodic-job-runner";

function createLogger() {
  const events: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const push = (level: string) => (payload: Record<string, unknown>) => {
    events.push({ level, payload });
  };

  return { events, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
}

describe("PeriodicJobRunner dependency gating", () => {
  it("skips iterations while dependencies are unready and resumes after recovery", async () => {
    let ready = false;
    let executions = 0;
    const { events, logger } = createLogger();
    const runner = new PeriodicJobRunner({
      name: "quote-expiration",
      intervalMs: 60_000,
      logger,
      canRun: () => ready,
      execute: () => {
        executions += 1;
        return Promise.resolve();
      }
    });

    for (let index = 0; index < 5; index += 1) {
      await runner.runNow();
    }

    expect(executions).toBe(0);
    expect(runner.status.lastPollAt).toBeNull();
    // One pause event for the whole outage, not one per skipped iteration.
    expect(events.map((event) => event.payload.event)).toEqual(["job.paused"]);

    ready = true;
    await runner.runNow();
    await runner.runNow();

    expect(executions).toBe(2);
    expect(events.map((event) => event.payload.event)).toEqual(["job.paused", "job.resumed"]);
    expect(runner.status).toMatchObject({ lastIterationFailed: false });
    expect(runner.status.lastSuccessAt).not.toBeNull();
  });

  it("survives a failing iteration and logs only sanitized error identity", async () => {
    const { events, logger } = createLogger();
    const runner = new PeriodicJobRunner({
      name: "quote-email-delivery",
      intervalMs: 60_000,
      logger,
      execute: () =>
        Promise.reject(
          Object.assign(new Error('duplicate key value (email)=(jane@example.com)'), { code: "23505" })
        )
    });

    await expect(runner.runNow()).resolves.toBeUndefined();

    expect(runner.status.lastIterationFailed).toBe(true);
    expect(events).toEqual([
      {
        level: "error",
        payload: { event: "job.failed", job: "quote-email-delivery", errorName: "Error", errorCode: "23505" }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("jane@example.com");
  });
});
