import type { CommittedArtifactManifest } from "../document/artifact-store-port";

/*
 * Delivery execution contract (R1.6B): the repository operations the
 * delivery worker and the expired-lease sweep need. PostgreSQL is the only
 * coordinator. Expected races are typed results, never exceptions.
 *
 * Fence: (deliveryId, generation, leaseOwner) while `status = 'sending'`.
 * The claim bumps the generation; so does the expired-lease sweep, which
 * fences out a late holder. A `sending` row is NEVER claimed again: its only
 * exits are the holder's own fenced completion or the sweep (→ `unknown`).
 */

export interface DeliveryFence {
  readonly deliveryId: string;
  readonly generation: number;
  readonly leaseOwner: string;
}

export interface ClaimedDelivery extends DeliveryFence {
  readonly quoteId: string;
  /** Attempt number of THIS attempt (1-based, counted at claim). */
  readonly attemptCount: number;
  readonly leaseExpiresAt: Date;
  readonly requestedAt: Date;
  readonly documentSha256: string;
}

export type ClaimResult =
  | { readonly kind: "CLAIMED"; readonly delivery: ClaimedDelivery }
  /** A6.1: the quote stopped being effectively `issued`; the delivery is now `failed` and the provider was never called. */
  | { readonly kind: "FAILED_INELIGIBLE"; readonly deliveryId: string; readonly quoteId: string; readonly errorCode: string; readonly attemptCount: number }
  | { readonly kind: "NONE_AVAILABLE" };

/**
 * What a send attempt needs, read in one snapshot. The recipient fields come
 * from the delivery's private snapshot columns (persisted by the request,
 * R1.6A); the worker uses them only to build the message and never logs,
 * audits or returns them.
 */
export interface DeliveryContent {
  readonly recipientEmail: string;
  readonly recipientName: string | null;
  readonly quoteNumber: string;
  readonly issueLocalDate: string;
  /** The quote's committed manifest (null only if missing, which an issued quote cannot be). */
  readonly manifest: (CommittedArtifactManifest & { readonly documentId: string; readonly quoteId: string }) | null;
}

export type AttemptOutcome =
  | { readonly kind: "accepted"; readonly providerMessageId: string | null }
  | { readonly kind: "not_accepted"; readonly retryable: boolean; readonly code: string }
  | { readonly kind: "ambiguous"; readonly code: string };

export type CompletionResult =
  | { readonly kind: "SENT" }
  | { readonly kind: "RESCHEDULED"; readonly nextAttemptAt: Date }
  | { readonly kind: "FAILED"; readonly exhausted: boolean }
  | { readonly kind: "UNKNOWN" }
  /** Fenced out (sweep or another generation won): zero effect. */
  | { readonly kind: "STALE"; readonly currentStatus: string | null }
  /** The COMMIT outcome is unknown and the row still shows our fence: NOT retried; the lease expires and the sweep makes it `unknown`. */
  | { readonly kind: "NOT_APPLIED" };

export interface SweptDelivery {
  readonly deliveryId: string;
  readonly quoteId: string;
  readonly generation: number;
  readonly attemptCount: number;
}

export interface DeliveryQueueMetrics {
  /** `pending` deliveries that are due (`next_attempt_at <= now`). */
  readonly queueDepth: number;
  /** Seconds since the oldest due `pending` delivery became due; null when none is due. */
  readonly oldestPendingAgeSeconds: number | null;
}

export interface DeliveryRepository {
  claimNext(leaseOwner: string): Promise<ClaimResult>;
  loadContent(deliveryId: string): Promise<DeliveryContent | null>;
  complete(fence: DeliveryFence, outcome: AttemptOutcome): Promise<CompletionResult>;
  sweepExpiredLeases(limit: number): Promise<SweptDelivery[]>;
  queueMetrics(): Promise<DeliveryQueueMetrics>;
}
