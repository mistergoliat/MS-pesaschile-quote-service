import crypto from "node:crypto";
import { safeErrorSummary } from "../../safe-error";

import type { CommittedArtifactReader } from "../document/artifact-store-port";
import type { WorkerLogger } from "../issuance-worker";
import type { AttemptOutcome, ClaimedDelivery, CompletionResult, DeliveryRepository } from "./delivery-execution";
import { DELIVERY_ERROR_CODES } from "./delivery-policy";
import type { DeliveryFailpoints } from "./delivery-failpoints";
import { buildEmailEnvelope, type EmailEnvelope } from "./email-envelope";
import { EMAIL_DELIVERY_ERROR_CODES, type MailSenderPort, type MailSendOutcome, type OutboundMailInlineAsset } from "./mail-sender-port";
import type { ProviderHealthTracker } from "./provider-health";

/*
 * V2 email delivery worker (R1.6B). One attempt at a time per process;
 * PostgreSQL coordinates processes (SKIP LOCKED claim + generation fence).
 *
 *   claim (pending → sending, A6.1 eligibility re-check under the quote lock)
 *   → load the delivery's snapshot and the committed manifest
 *   → manifest must belong to the delivery's quote and equal its pinned hash
 *   → readVerified(manifest) → sha256(bytes) == document_sha256 again
 *   → envelope (no commercial content) → provider (bounded by its timeouts)
 *   → fenced completion: sent / pending / failed / unknown.
 *
 * Every failure BEFORE the provider call is provably "not sent". A throw
 * from the provider adapter is ambiguous (it may have been accepted). The
 * lease is NOT renewed: provider timeouts are bounded well below it, and an
 * attempt that outlives its lease is resolved by the sweep as `unknown`,
 * never retried. A fenced-out completion has zero effect and is logged as
 * `delivery.late_result`; nothing is ever sent again to compensate.
 *
 * Logs carry ids, counts, codes and durations only: never the recipient,
 * its name, the subject, the body, the PDF or provider data beyond the
 * opaque provider message id.
 */

export interface DeliveryWorkerConfig {
  readonly leaseOwner: string;
  readonly leaseMs: number;
  /** Upper bound of one provider call (token + send timeouts). */
  readonly providerBudgetMs: number;
  /** Upper bound of reading the committed PDF. */
  readonly documentReadTimeoutMs: number;
  /** Margin kept between the end of the provider call and lease expiry, for the completion transaction. */
  readonly completionMarginMs: number;
  readonly maxClaimsPerTick: number;
}

export interface DeliveryWorkerDependencies {
  readonly repository: DeliveryRepository;
  readonly sender: MailSenderPort;
  readonly documents: CommittedArtifactReader;
  readonly renderHtml: (envelope: EmailEnvelope) => { readonly html: string; readonly inlineAssets: readonly OutboundMailInlineAsset[] };
  readonly attachmentFileName: (quoteNumber: string) => string;
  readonly providerHealth: ProviderHealthTracker;
  readonly lifecycle: { readonly isShuttingDown: boolean };
  readonly logger: WorkerLogger;
  /** Local monotonic clock (lease budget only; never persisted). */
  readonly monotonicNow?: () => number;
  /** Test compositions only (delivery-failpoints.ts); production passes nothing. */
  readonly failpoints?: DeliveryFailpoints | undefined;
}

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");
const errorName = (error: unknown): string => safeErrorSummary(error).errorName;

type Prepared =
  | { readonly kind: "ready"; readonly mail: Parameters<MailSenderPort["send"]>[0]; readonly templateVersion: string }
  | { readonly kind: "failed"; readonly outcome: AttemptOutcome };

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class DeliveryWorker {
  private stopping = false;
  private slotTaken = false;
  readonly #now: () => number;

  constructor(
    private readonly deps: DeliveryWorkerDependencies,
    private readonly config: DeliveryWorkerConfig
  ) {
    this.#now = deps.monotonicNow ?? (() => performance.now());

    if (config.providerBudgetMs + config.completionMarginMs >= config.leaseMs) {
      throw new Error("delivery lease must exceed the provider budget plus the completion margin");
    }
  }

  /** No new claims and no new provider calls; an in-flight provider call completes under its own timeouts. */
  stop(): void {
    this.stopping = true;
  }

  /** Claim and run up to `maxClaimsPerTick` deliveries sequentially. Returns the number of claims (including A6.1 failures). */
  async tick(): Promise<number> {
    let claims = 0;

    while (claims < this.config.maxClaimsPerTick && !this.stopping && !this.deps.lifecycle.isShuttingDown && !this.slotTaken) {
      this.slotTaken = true;

      try {
        const claim = await this.deps.repository.claimNext(this.config.leaseOwner);

        if (claim.kind === "NONE_AVAILABLE") {
          break;
        }

        claims += 1;

        if (claim.kind === "FAILED_INELIGIBLE") {
          this.deps.logger.warn(
            { event: "delivery.failed", deliveryId: claim.deliveryId, quoteId: claim.quoteId, attemptCount: claim.attemptCount, errorCode: claim.errorCode, providerCalled: false },
            "Delivery failed before provider execution: the quote is no longer issued"
          );
          continue;
        }

        await this.runAttempt(claim.delivery);
      } finally {
        this.slotTaken = false;
      }
    }

    return claims;
  }

  private async runAttempt(delivery: ClaimedDelivery): Promise<void> {
    const startedAt = this.#now();
    const ids = { deliveryId: delivery.deliveryId, quoteId: delivery.quoteId, generation: delivery.generation, attemptCount: delivery.attemptCount };
    this.deps.logger.info({ event: "delivery.claimed", ...ids }, "Delivery claimed");
    const checkpoint = { deliveryId: delivery.deliveryId, generation: delivery.generation };
    await this.deps.failpoints?.reach("delivery_after_claim", checkpoint);

    const prepared = await this.prepare(delivery);
    let outcome: AttemptOutcome;
    let providerCalled = false;
    let providerMs: number | null = null;
    let templateVersion: string | null = null;

    if (prepared.kind === "failed") {
      outcome = prepared.outcome;
    } else if (this.stopping || this.deps.lifecycle.isShuttingDown) {
      outcome = { kind: "not_accepted", retryable: true, code: DELIVERY_ERROR_CODES.interrupted };
    } else if (this.#now() - startedAt + this.config.providerBudgetMs + this.config.completionMarginMs >= this.config.leaseMs) {
      // Not enough lease left to finish the provider call and record it: do not start it.
      outcome = { kind: "not_accepted", retryable: true, code: DELIVERY_ERROR_CODES.interrupted };
    } else {
      providerCalled = true;
      templateVersion = prepared.templateVersion;
      const providerStartedAt = this.#now();
      let sent: MailSendOutcome;

      try {
        sent = await this.deps.sender.send(prepared.mail);
      } catch (error) {
        // An adapter must not throw for provider outcomes; a throw may have happened after submission.
        this.deps.logger.error({ event: "delivery.sender_error", ...ids, errorName: errorName(error) }, "Mail sender threw; outcome treated as ambiguous");
        sent = { kind: "ambiguous", code: EMAIL_DELIVERY_ERROR_CODES.outcomeUnknown };
      }

      this.deps.providerHealth.record(sent);
      outcome = sent;
      providerMs = Math.round(this.#now() - providerStartedAt);
      await this.deps.failpoints?.reach("delivery_after_provider_outcome", checkpoint);
    }

    let result: CompletionResult;

    try {
      result = await this.deps.repository.complete(delivery, outcome);
    } catch (error) {
      // The row stays `sending` under our fence: the lease expires and the sweep records `unknown`. Never re-sent.
      this.deps.logger.error(
        { event: "delivery.completion_failed", ...ids, outcome: outcome.kind, errorName: errorName(error), providerCalled },
        "Delivery completion could not be recorded; the expired lease will resolve it as unknown"
      );
      return;
    }

    await this.deps.failpoints?.reach("delivery_after_completion", checkpoint);
    this.report(ids, outcome, result, { providerCalled, providerMs, templateVersion, durationMs: Math.round(this.#now() - startedAt) });
  }

  /** Everything before the provider call. Any failure here is provably "not sent". */
  private async prepare(delivery: ClaimedDelivery): Promise<Prepared> {
    const notSent = (code: string, retryable = true): Prepared => ({ kind: "failed", outcome: { kind: "not_accepted", retryable, code } });
    let content;

    try {
      content = await this.deps.repository.loadContent(delivery.deliveryId);
    } catch (error) {
      this.deps.logger.warn({ event: "delivery.prepare_failed", deliveryId: delivery.deliveryId, stage: "load", errorName: errorName(error) }, "Delivery data could not be loaded");
      return notSent(DELIVERY_ERROR_CODES.preparationFailed);
    }

    if (!content) {
      return notSent(DELIVERY_ERROR_CODES.preparationFailed);
    }

    const manifest = content.manifest;

    // Exactly the pinned, committed document of THIS quote: never another manifest, never a re-render.
    if (!manifest || manifest.quoteId !== delivery.quoteId || manifest.pdfSha256 !== delivery.documentSha256) {
      this.deps.logger.error(
        { event: "document.integrity_failed", quoteId: delivery.quoteId, deliveryId: delivery.deliveryId, documentId: manifest?.documentId ?? null, integrityStatus: "MANIFEST_MISMATCH" },
        "Committed manifest does not match the delivery's pinned document; not sending"
      );
      return notSent(DELIVERY_ERROR_CODES.documentStorageFailed);
    }

    let bytes: Buffer;

    try {
      const read = await withTimeout(this.deps.documents.readVerified(manifest), this.config.documentReadTimeoutMs);

      if (read === "timeout" || read.status !== "OK") {
        this.deps.logger.error(
          {
            event: "document.integrity_failed",
            quoteId: delivery.quoteId,
            deliveryId: delivery.deliveryId,
            documentId: manifest.documentId,
            origin: manifest.origin,
            integrityStatus: read === "timeout" ? "READ_TIMEOUT" : read.status,
            fsCode: read === "timeout" ? null : read.fsCode
          },
          "Committed document failed verification; not sending"
        );
        return notSent(DELIVERY_ERROR_CODES.documentStorageFailed);
      }

      bytes = read.bytes;
    } catch (error) {
      this.deps.logger.error({ event: "document.integrity_failed", quoteId: delivery.quoteId, deliveryId: delivery.deliveryId, integrityStatus: "READ_FAILED", errorName: errorName(error) }, "Committed document read failed; not sending");
      return notSent(DELIVERY_ERROR_CODES.documentStorageFailed);
    }

    if (sha256(bytes) !== delivery.documentSha256) {
      this.deps.logger.error(
        { event: "document.integrity_failed", quoteId: delivery.quoteId, deliveryId: delivery.deliveryId, documentId: manifest.documentId, integrityStatus: "HASH_MISMATCH" },
        "Committed document bytes do not match the pinned hash; not sending"
      );
      return notSent(DELIVERY_ERROR_CODES.documentStorageFailed);
    }

    try {
      const envelope = buildEmailEnvelope({ quoteNumber: content.quoteNumber, issueLocalDate: content.issueLocalDate, recipientName: content.recipientName });
      const rendered = this.deps.renderHtml(envelope);

      return {
        kind: "ready",
        templateVersion: envelope.templateVersion,
        mail: {
          deliveryId: delivery.deliveryId,
          to: content.recipientEmail,
          subject: envelope.subject,
          html: rendered.html,
          attachments: [{ filename: this.deps.attachmentFileName(content.quoteNumber), contentType: "application/pdf", content: bytes }],
          inlineAssets: rendered.inlineAssets
        }
      };
    } catch (error) {
      this.deps.logger.error({ event: "delivery.prepare_failed", deliveryId: delivery.deliveryId, stage: "envelope", errorName: errorName(error) }, "Email envelope could not be built");
      return notSent(DELIVERY_ERROR_CODES.preparationFailed);
    }
  }

  private report(
    ids: Record<string, unknown>,
    outcome: AttemptOutcome,
    result: CompletionResult,
    facts: { readonly providerCalled: boolean; readonly providerMs: number | null; readonly templateVersion: string | null; readonly durationMs: number }
  ): void {
    const { logger } = this.deps;
    const base = { ...ids, providerCalled: facts.providerCalled, providerMs: facts.providerMs, durationMs: facts.durationMs };

    switch (result.kind) {
      case "SENT":
        logger.info(
          {
            event: "delivery.sent",
            ...base,
            providerMessageId: outcome.kind === "accepted" ? outcome.providerMessageId : null,
            templateVersion: facts.templateVersion
          },
          "Delivery sent"
        );
        return;
      case "RESCHEDULED":
        logger.warn(
          { event: "delivery.attempt_failed", ...base, errorCode: outcome.kind === "accepted" ? null : outcome.code, nextAttemptAt: result.nextAttemptAt.toISOString() },
          "Delivery attempt failed (not sent); retry scheduled"
        );
        return;
      case "FAILED":
        logger.error(
          { event: "delivery.failed", ...base, errorCode: outcome.kind === "accepted" ? null : outcome.code, retryExhausted: result.exhausted },
          "Delivery failed (not sent)"
        );
        return;
      case "UNKNOWN":
        logger.error(
          { event: "delivery.outcome_unknown", ...base, errorCode: outcome.kind === "accepted" ? null : outcome.code },
          "Delivery outcome unknown: the provider may have accepted it; it will not be retried"
        );
        return;
      case "STALE":
        logger.warn(
          {
            event: "delivery.late_result",
            ...base,
            outcome: outcome.kind,
            providerMessageId: outcome.kind === "accepted" ? outcome.providerMessageId : null,
            currentStatus: result.currentStatus
          },
          "Late delivery result fenced out; the delivery was not changed and is never re-sent"
        );
        return;
      case "NOT_APPLIED":
        logger.error(
          {
            event: "delivery.completion_unknown",
            ...base,
            outcome: outcome.kind,
            providerMessageId: outcome.kind === "accepted" ? outcome.providerMessageId : null
          },
          "Delivery completion commit outcome unknown; the expired lease will resolve it as unknown"
        );
        return;
    }
  }
}

/** Expired-`sending` sweep trigger body: bounded batches; persistence only. */
export class DeliveryLeaseSweeper {
  constructor(
    private readonly repository: Pick<DeliveryRepository, "sweepExpiredLeases">,
    private readonly lifecycle: { readonly isShuttingDown: boolean },
    private readonly config: { readonly batchSize: number; readonly maxBatchesPerTick: number },
    private readonly logger: WorkerLogger
  ) {}

  async tick(): Promise<number> {
    let total = 0;

    for (let batch = 0; batch < this.config.maxBatchesPerTick && !this.lifecycle.isShuttingDown; batch += 1) {
      const swept = await this.repository.sweepExpiredLeases(this.config.batchSize);

      for (const delivery of swept) {
        this.logger.error(
          {
            event: "delivery.outcome_unknown",
            deliveryId: delivery.deliveryId,
            quoteId: delivery.quoteId,
            generation: delivery.generation,
            attemptCount: delivery.attemptCount,
            errorCode: DELIVERY_ERROR_CODES.outcomeUnknown,
            reason: "lease_expired"
          },
          "Delivery lease expired while sending: outcome unknown; it will not be retried"
        );
      }

      total += swept.length;

      if (swept.length < this.config.batchSize) {
        break;
      }
    }

    return total;
  }
}
