/*
 * Delivery failpoints (R1.6B crash harness), same rules as the issuance
 * failpoints: only `BuildApplicationOverrides.deliveryFailpoints` (a
 * constructor argument that `src/server.ts` never passes) can supply an
 * implementation; no environment variable, configuration key or route can
 * enable one, and every call site is `await failpoints?.reach(...)`.
 */
export const DELIVERY_CHECKPOINTS = [
  /** BJ: delivery claimed (`sending`, generation g), before anything else (no provider call yet). */
  "delivery_after_claim",
  /** BK/BM: the provider returned its outcome, before the fenced completion. */
  "delivery_after_provider_outcome",
  /** BL: the completion COMMIT returned, before the worker reports it. */
  "delivery_after_completion"
] as const;

export type DeliveryCheckpoint = (typeof DELIVERY_CHECKPOINTS)[number];

export interface DeliveryFailpoints {
  reach(checkpoint: DeliveryCheckpoint, context: { readonly deliveryId: string; readonly generation: number }): Promise<void>;
}
