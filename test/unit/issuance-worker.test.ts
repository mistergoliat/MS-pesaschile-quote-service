import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttemptFailure,
  ClaimedAttempt,
  ClaimResult,
  CommitIssuedResult,
  FailAttemptResult,
  IssuanceAttemptErrorCode,
  IssuanceOperationRepository,
  OperationFence,
  RenewResult
} from "../../src/application/quote-v2/issuance-operation";
import {
  createWorkerInstanceId,
  IssuanceAttemptError,
  IssuanceDeadlineSweeper,
  IssuanceWorker,
  LeaseRenewal,
  type AttemptBody
} from "../../src/application/quote-v2/issuance-worker";
import { SnapshotIntegrityError, type IssuedSnapshot } from "../../src/application/quote-v2/issued-snapshot";

const attempt = (n: number): ClaimedAttempt => ({
  operationId: `op-${n}`,
  quoteId: `quote-${n}`,
  generation: 1,
  leaseOwner: "worker-a",
  attemptCount: 1,
  leaseExpiresAt: new Date("2026-10-05T12:01:00Z"),
  deadlineAt: new Date("2026-10-06T12:00:00Z"),
  snapshotHash: "a".repeat(64),
  reclaimed: false
});

class FakeRepository implements IssuanceOperationRepository {
  queue: ClaimedAttempt[] = [];
  claims = 0;
  failures: Array<{ fence: OperationFence; code: IssuanceAttemptErrorCode }> = [];
  renewals: OperationFence[] = [];
  renewResults: Array<RenewResult | Error> = [];
  snapshotError: Error | null = null;

  claimNext(): Promise<ClaimResult> {
    this.claims += 1;
    const next = this.queue.shift();
    return Promise.resolve(next ? { kind: "CLAIMED", attempt: next } : { kind: "NONE_AVAILABLE" });
  }

  renewLease(fence: OperationFence): Promise<RenewResult> {
    this.renewals.push(fence);
    const result = this.renewResults.shift() ?? { kind: "RENEWED", leaseExpiresAt: new Date() };
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }

  failAttempt(fence: OperationFence, failure: AttemptFailure): Promise<FailAttemptResult> {
    this.failures.push({ fence, code: failure.errorCode });
    this.failureDetails.push(failure);
    return Promise.resolve(failure.retryable ? { kind: "RESCHEDULED", nextAttemptAt: new Date(), attemptCount: 1 } : { kind: "FAILED_NON_RETRYABLE" });
  }

  failureDetails: AttemptFailure[] = [];
  operationClaims: string[] = [];

  claimOperation(operationId: string): Promise<ClaimResult> {
    this.operationClaims.push(operationId);
    const index = this.queue.findIndex((queued) => queued.operationId === operationId);
    return Promise.resolve(index === -1 ? { kind: "NONE_AVAILABLE" } : { kind: "CLAIMED", attempt: this.queue.splice(index, 1)[0]! });
  }

  commitIssued(): Promise<CommitIssuedResult> {
    return Promise.resolve({ kind: "COMMITTED", generatedAt: new Date() });
  }

  failDeadlineExceeded = vi.fn(() => Promise.resolve([]));
  createOperatorRetry = vi.fn();

  loadVerifiedSnapshot(): Promise<IssuedSnapshot> {
    return this.snapshotError ? Promise.reject(this.snapshotError) : Promise.resolve({} as IssuedSnapshot);
  }
}

function harness(body: AttemptBody, options: { maxClaimsPerTick?: number; leaseMs?: number } = {}) {
  const repository = new FakeRepository();
  const lifecycle = { isShuttingDown: false };
  const logs: Array<Record<string, unknown>> = [];
  const log = (payload: Record<string, unknown>) => void logs.push(payload);
  const worker = new IssuanceWorker(
    repository,
    body,
    lifecycle,
    { leaseOwner: "worker-a", leaseMs: options.leaseMs ?? 60_000, maxClaimsPerTick: options.maxClaimsPerTick ?? 3 },
    { info: log, warn: log, error: log }
  );
  return { repository, lifecycle, logs, worker, events: () => logs.map((entry) => entry.event) };
}

const failWith =
  (errorCode: IssuanceAttemptErrorCode): AttemptBody =>
  () =>
    Promise.resolve({ kind: "failed", errorCode, retryable: true, reason: errorCode });

afterEach(() => {
  vi.useRealTimers();
});

describe("IssuanceWorker", () => {
  it("claims at most maxClaimsPerTick, one attempt at a time, and reports typed failures", async () => {
    let running = 0;
    let maxRunning = 0;
    const { repository, worker, events } = harness(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { kind: "failed", errorCode: "document_storage_failed", retryable: true, reason: "storage_unavailable" };
    });
    repository.queue = [attempt(1), attempt(2), attempt(3), attempt(4)];

    expect(await worker.tick()).toBe(3);
    expect(maxRunning).toBe(1);
    expect(repository.failures.map((failure) => [failure.fence.operationId, failure.code])).toEqual([
      ["op-1", "document_storage_failed"],
      ["op-2", "document_storage_failed"],
      ["op-3", "document_storage_failed"]
    ]);
    expect(events().filter((event) => event === "issuance.claimed")).toHaveLength(3);
    expect(events()).toContain("issuance.attempt_failed");
  });

  it("stops claiming when nothing is due and logs nothing for an empty poll", async () => {
    const { repository, worker, logs } = harness(failWith("document_generation_failed"));

    expect(await worker.tick()).toBe(0);
    expect(repository.claims).toBe(1);
    expect(logs).toEqual([]);
  });

  it("BD: a shutting-down lifecycle never claims", async () => {
    const { repository, lifecycle, worker } = harness(failWith("document_generation_failed"));
    repository.queue = [attempt(1)];
    lifecycle.isShuttingDown = true;

    expect(await worker.tick()).toBe(0);
    expect(repository.claims).toBe(0);
  });

  it("BE: after stop() no further claim is made", async () => {
    const { repository, worker } = harness(failWith("document_generation_failed"));
    repository.queue = [attempt(1)];
    worker.stop();

    expect(await worker.tick()).toBe(0);
    expect(repository.claims).toBe(0);
  });

  it("AR: a snapshot hash mismatch fails the attempt before the body runs", async () => {
    const body = vi.fn<AttemptBody>();
    const { repository, worker, events } = harness(body);
    repository.queue = [attempt(1)];
    repository.snapshotError = new SnapshotIntegrityError("op-1", "a".repeat(64), "b".repeat(64));

    await worker.tick();

    expect(body).not.toHaveBeenCalled();
    expect(repository.failures).toEqual([{ fence: attempt(1), code: "document_generation_failed" }]);
    expect(events()).toContain("issuance.snapshot_integrity_failed");
  });

  it("AC: only a typed code leaves the attempt; thrown messages never do", async () => {
    const { repository, worker, logs } = harness(() => {
      throw new Error("ENOENT: open '/srv/quotes/artifacts/tmp/x.tmp' for customer Camila Rojas");
    });
    repository.queue = [attempt(1)];
    await worker.tick();

    expect(repository.failures.map((failure) => failure.code)).toEqual(["document_generation_failed"]);
    expect(JSON.stringify(logs)).not.toMatch(/srv|Camila|ENOENT/);
  });

  it("maps a typed IssuanceAttemptError to its code", async () => {
    const { repository, worker } = harness(() => Promise.reject(new IssuanceAttemptError("dependency_unavailable")));
    repository.queue = [attempt(1)];
    await worker.tick();

    expect(repository.failures.map((failure) => failure.code)).toEqual(["dependency_unavailable"]);
  });

  it("BG: stop() during an attempt aborts it and writes nothing (no success, no failure)", async () => {
    let seenSignal: AbortSignal | null = null;
    const { repository, worker } = harness(
      ({ signal }) =>
        new Promise((resolve) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => resolve({ kind: "failed", errorCode: "document_generation_failed", retryable: true, reason: "test" }));
        })
    );
    repository.queue = [attempt(1), attempt(2)];
    const ticking = worker.tick();
    await vi.waitFor(() => expect(seenSignal).not.toBeNull());
    worker.stop();

    expect(await ticking).toBe(1);
    expect(seenSignal!.aborted).toBe(true);
    expect(repository.failures).toEqual([]);
    expect(repository.claims).toBe(1);
  });

  it("a lost lease aborts the attempt and suppresses its failure write", async () => {
    vi.useFakeTimers();
    const { repository, worker, events } = harness(
      ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed", errorCode: "document_generation_failed", retryable: true, reason: "test" }))),
      { leaseMs: 30_000 }
    );
    repository.queue = [attempt(1)];
    repository.renewResults = [{ kind: "RENEWED", leaseExpiresAt: new Date() }, { kind: "STALE_FENCE" }];
    const ticking = worker.tick();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.renewals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await ticking).toBe(1);
    expect(repository.renewals).toHaveLength(2);
    expect(repository.failures).toEqual([]);
    expect(events()).toContain("issuance.lease_lost");
  });
});

describe("LeaseRenewal", () => {
  it("renews every third of the lease with the attempt's fence, survives a transient error, and stops cleanly", async () => {
    vi.useFakeTimers();
    const repository = new FakeRepository();
    repository.renewResults = [{ kind: "RENEWED", leaseExpiresAt: new Date() }, new Error("connection reset"), { kind: "RENEWED", leaseExpiresAt: new Date() }];
    const lease = new LeaseRenewal(repository, attempt(7), 60_000, { info: () => undefined, warn: () => undefined, error: () => undefined });
    lease.start();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(repository.renewals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(repository.renewals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(repository.renewals).toHaveLength(3);
    expect(repository.renewals.every((fence) => fence.operationId === "op-7" && fence.generation === 1 && fence.leaseOwner === "worker-a")).toBe(true);
    expect(lease.state).toBe("held");
    expect(lease.signal.aborted).toBe(false);

    await lease.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(repository.renewals).toHaveLength(3);
  });

  it("stops at the deadline and makes it visible to the attempt", async () => {
    vi.useFakeTimers();
    const repository = new FakeRepository();
    repository.renewResults = [{ kind: "DEADLINE_REACHED" }];
    const lease = new LeaseRenewal(repository, attempt(8), 30_000, { info: () => undefined, warn: () => undefined, error: () => undefined });
    lease.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(repository.renewals).toHaveLength(1);
    expect(lease.state).toBe("deadline");
    expect(lease.signal.aborted).toBe(true);
  });

  it("does not keep the process alive", () => {
    const repository = new FakeRepository();
    const lease = new LeaseRenewal(repository, attempt(9), 30_000, { info: () => undefined, warn: () => undefined, error: () => undefined });
    lease.start();
    const timer = (lease as unknown as { timer: NodeJS.Timeout }).timer;

    expect(timer.hasRef()).toBe(false);
    void lease.stop();
  });
});

describe("IssuanceDeadlineSweeper", () => {
  it("processes bounded batches and stops between batches when shutting down", async () => {
    const lifecycle = { isShuttingDown: false };
    const batches = [
      [{ operationId: "a", quoteId: "q", previousStatus: "pending" as const, generation: 1 }],
      [{ operationId: "b", quoteId: "q", previousStatus: "running" as const, generation: 3 }]
    ];
    const repository = {
      failDeadlineExceeded: vi.fn((limit: number) => {
        expect(limit).toBe(1);
        const batch = batches.shift() ?? [];
        lifecycle.isShuttingDown = batches.length === 0;
        return Promise.resolve(batch);
      })
    };
    const logs: Array<Record<string, unknown>> = [];
    const sweeper = new IssuanceDeadlineSweeper(repository, lifecycle, { batchSize: 1, maxBatchesPerTick: 10 }, {
      info: () => undefined,
      warn: () => undefined,
      error: (payload) => void logs.push(payload)
    });

    expect(await sweeper.tick()).toBe(2);
    expect(repository.failDeadlineExceeded).toHaveBeenCalledTimes(2);
    expect(logs.map((entry) => [entry.event, entry.operationId, entry.errorCode])).toEqual([
      ["issuance.deadline_failed", "a", "issuance_deadline_exceeded"],
      ["issuance.deadline_failed", "b", "issuance_deadline_exceeded"]
    ]);
  });
});

describe("worker instance identity", () => {
  it("is unique per construction, bounded, and not just the host name", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createWorkerInstanceId()));

    expect(ids.size).toBe(50);

    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(200);
      expect(id).not.toBe(os.hostname());
      expect(id).not.toContain(os.hostname());
    }
  });
});

describe("IssuanceWorker (R1.5B3)", () => {
  it("a succeeded attempt writes no failure", async () => {
    const { repository, worker, events } = harness(() => Promise.resolve({ kind: "succeeded" }));
    repository.queue = [attempt(1)];

    expect(await worker.tick()).toBe(1);
    expect(repository.failures).toEqual([]);
    expect(events()).toContain("issuance.succeeded");
  });

  it("A5: a non-retryable failure is recorded as such (operation failed at once, not rescheduled)", async () => {
    const { repository, worker, events } = harness(() => Promise.reject(new IssuanceAttemptError("document_generation_failed", false, "unsupported_glyph")));
    repository.queue = [attempt(1)];
    await worker.tick();

    expect(repository.failureDetails).toEqual([{ errorCode: "document_generation_failed", retryable: false, reason: "unsupported_glyph" }]);
    expect(events()).toContain("issuance.failed_non_retryable");
  });

  it("one attempt per process: the inline path and the periodic worker share a single slot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { repository, worker } = harness(async () => {
      await gate;
      return { kind: "succeeded" };
    });
    repository.queue = [attempt(1), attempt(2), attempt(3)];

    const inline = worker.runOperation("op-2", "req-1");
    await vi.waitFor(() => expect(repository.operationClaims).toEqual(["op-2"]));

    // While the inline attempt runs, neither a tick nor another inline request can start one.
    expect(await worker.tick()).toBe(0);
    expect(await worker.runOperation("op-3", null)).toEqual({ kind: "busy" });
    expect(repository.claims).toBe(0);

    release();
    expect(await inline).toEqual({ kind: "ran", outcome: { kind: "succeeded" } });
    expect(await worker.runOperation("op-9", null)).toEqual({ kind: "not_claimed" });
    expect(await worker.tick()).toBe(2);
  });
});
