import { describe, expect, it, vi } from "vitest";

import { classifyAttemptError, IssuanceAttemptError } from "../../src/application/quote-v2/attempt-failure";
import { ArtifactStoreError } from "../../src/application/quote-v2/document/artifact-store-port";
import { InvalidIssuedSnapshotError } from "../../src/application/quote-v2/document/issued-quote-document-model";
import { UnknownIssuerProfileError } from "../../src/application/quote-v2/document/issuer-profiles";
import { DocumentRenderError } from "../../src/application/quote-v2/document/pdf-renderer-port";
import { InlineIssuance } from "../../src/application/quote-v2/inline-issuance";
import { createIssuanceAttemptBody } from "../../src/application/quote-v2/issuance-attempt";
import type { ClaimedAttempt, CommitIssuedResult, IssuedDocumentInput, OperationFence } from "../../src/application/quote-v2/issuance-operation";
import type { RunOperationResult } from "../../src/application/quote-v2/issuance-worker";
import { SnapshotIntegrityError } from "../../src/application/quote-v2/issued-snapshot";
import { createLinesFixture } from "../../src/scripts/pdf-fixture";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("A5 retry classification (attempt-failure.ts)", () => {
  it.each([
    ["unsupported glyph", new DocumentRenderError("unsupported_glyph", ["U+6F22"]), "document_generation_failed", false, "unsupported_glyph"],
    ["renderer unavailable", new DocumentRenderError("renderer_unavailable"), "dependency_unavailable", true, "renderer_unavailable"],
    ["render engine failure", new DocumentRenderError("render_failed"), "document_generation_failed", true, "render_failed"],
    ["snapshot not renderable", new InvalidIssuedSnapshotError("x"), "document_generation_failed", false, "snapshot_not_renderable"],
    ["unknown issuer profile", new UnknownIssuerProfileError("x"), "document_generation_failed", false, "snapshot_not_renderable"],
    ["snapshot hash mismatch", new SnapshotIntegrityError("op", "a", "b"), "document_generation_failed", false, "snapshot_integrity"],
    ["different bytes at the address", new ArtifactStoreError("integrity_conflict"), "document_storage_failed", false, "artifact_integrity_conflict"],
    ["storage unavailable", new ArtifactStoreError("storage_unavailable", "ENOSPC"), "document_storage_failed", true, "storage_unavailable"],
    ["storage misconfigured", new ArtifactStoreError("storage_misconfigured", "EACCES"), "document_storage_failed", true, "storage_misconfigured"],
    ["explicit typed failure", new IssuanceAttemptError("dependency_unavailable", false, "custom"), "dependency_unavailable", false, "custom"],
    ["anything else", new Error("unsupported_glyph integrity_conflict"), "document_generation_failed", true, "unclassified"]
  ])("%s → %s (retryable: %s)", (_name, error, errorCode, retryable, reason) => {
    expect(classifyAttemptError(error)).toEqual({ errorCode, retryable, reason });
  });

  it("never uses issuance_deadline_exceeded for an attempt failure", () => {
    for (const error of [new DocumentRenderError("unsupported_glyph"), new ArtifactStoreError("integrity_conflict"), new Error("x")]) {
      expect(classifyAttemptError(error).errorCode).not.toBe("issuance_deadline_exceeded");
    }
  });
});

describe("issuance attempt body", () => {
  const attempt: ClaimedAttempt = {
    operationId: "op-1",
    quoteId: "q-1",
    generation: 3,
    leaseOwner: "worker-a",
    attemptCount: 2,
    leaseExpiresAt: new Date(),
    deadlineAt: new Date(),
    snapshotHash: "c".repeat(64),
    reclaimed: false
  };
  const harness = (commit: CommitIssuedResult = { kind: "COMMITTED", generatedAt: new Date() }) => {
    const steps: string[] = [];
    const commits: Array<[OperationFence, IssuedDocumentInput]> = [];
    const body = createIssuanceAttemptBody({
      repository: {
        commitIssued: (fence, document) => {
          steps.push("commit");
          commits.push([fence, document]);
          return Promise.resolve(commit);
        }
      },
      renderer: {
        rendererVersion: "renderer-x",
        probe: () => Promise.resolve({ ok: true }),
        renderPdf: () => {
          steps.push("render");
          return Promise.resolve(Buffer.from("%PDF-test"));
        }
      },
      store: {
        publish: (bytes) => {
          steps.push("publish");
          return Promise.resolve({ storageKey: "artifacts/sha256/aa/bb/x.pdf", pdfSha256: "d".repeat(64), byteLength: bytes.byteLength, reused: false });
        }
      },
      logger: silent
    });
    return { body, steps, commits };
  };

  it("G: renders, publishes, then commits T5 with the published, verified artifact", async () => {
    const { body, steps, commits } = harness();
    const outcome = await body({ attempt, snapshot: createLinesFixture(1), signal: new AbortController().signal, correlationId: "req-7" });

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(steps).toEqual(["render", "publish", "commit"]);
    expect(commits[0]).toEqual([
      attempt,
      {
        semanticSnapshotHash: attempt.snapshotHash,
        pdfSha256: "d".repeat(64),
        byteLength: 9,
        storageKey: "artifacts/sha256/aa/bb/x.pdf",
        rendererVersion: "renderer-x",
        templateVersion: "quote-pdf-template-v4",
        correlationId: "req-7"
      }
    ]);
  });

  it("stops before any further business effect once the lease signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { body, steps } = harness();

    expect(await body({ attempt, snapshot: createLinesFixture(1), signal: controller.signal, correlationId: null })).toEqual({ kind: "abandoned" });
    expect(steps).toEqual([]);
  });

  it("a fenced-out commit abandons the attempt (no success, no failure write)", async () => {
    for (const result of [{ kind: "STALE_FENCE" }, { kind: "NOT_APPLIED" }] as const) {
      const { body } = harness(result);
      expect(await body({ attempt, snapshot: createLinesFixture(1), signal: new AbortController().signal, correlationId: null })).toEqual({ kind: "abandoned" });
    }
  });
});

describe("InlineIssuance", () => {
  const inline = (run: () => Promise<RunOperationResult>, options: { budgetMs: number; ready?: boolean; active?: () => Promise<boolean> }) => {
    const worker = { runOperation: vi.fn(run) };
    const isOperationActive = vi.fn(options.active ?? (() => Promise.resolve(false)));
    return {
      worker,
      isOperationActive,
      inline: new InlineIssuance({
        worker,
        readiness: { isReady: () => options.ready ?? true },
        isOperationActive,
        syncBudgetMs: options.budgetMs,
        logger: silent,
        observeIntervalMs: 10
      })
    };
  };

  it("AG: budget 0 → no synchronous attempt at all", async () => {
    const { inline: driver, worker } = inline(() => Promise.resolve({ kind: "ran", outcome: { kind: "succeeded" } }), { budgetMs: 0 });
    await driver.drive("op-1", null);

    expect(worker.runOperation).not.toHaveBeenCalled();
  });

  it("does not attempt while dependencies are not ready", async () => {
    const { inline: driver, worker } = inline(() => Promise.resolve({ kind: "busy" }), { budgetMs: 1_000, ready: false });
    await driver.drive("op-1", null);

    expect(worker.runOperation).not.toHaveBeenCalled();
  });

  it("returns as soon as its own attempt finishes", async () => {
    const { inline: driver, worker, isOperationActive } = inline(() => Promise.resolve({ kind: "ran", outcome: { kind: "succeeded" } }), { budgetMs: 5_000 });
    const startedAt = Date.now();
    await driver.drive("op-1", "req-1");

    expect(worker.runOperation).toHaveBeenCalledWith("op-1", "req-1");
    expect(isOperationActive).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("returns at the budget while a slow attempt keeps running under its lease", async () => {
    let finished = false;
    const { inline: driver } = inline(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve({ kind: "ran", outcome: { kind: "succeeded" } });
          }, 300)
        ),
      { budgetMs: 50 }
    );
    const startedAt = Date.now();
    await driver.drive("op-1", null);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(finished).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(true);
  });

  it("AK: when another holder has the operation it observes durable state instead of duplicating work", async () => {
    let checks = 0;
    const { inline: driver } = inline(() => Promise.resolve({ kind: "not_claimed" }), {
      budgetMs: 2_000,
      active: () => Promise.resolve(++checks < 3)
    });
    await driver.drive("op-1", null);

    expect(checks).toBe(3);
  });
});
