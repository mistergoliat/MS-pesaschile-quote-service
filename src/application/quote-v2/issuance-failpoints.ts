/*
 * Issuance failpoints (R1.5B4 failure-injection harness).
 *
 * Named checkpoints on the issuance path where a TEST composition can stop
 * the process (or hold it, to be killed from outside). Production never
 * supplies an implementation: the only way in is
 * `BuildApplicationOverrides.issuanceFailpoints`, a constructor argument that
 * `src/server.ts` does not pass. No environment variable, configuration key
 * or HTTP route can enable a failpoint, and the default is no checkpoint at
 * all (`undefined`, every call site is `await failpoints?.reach(...)`).
 *
 * Checkpoints (crash matrix F1–F10, docs/issuance-crash-matrix.md):
 */
export const ISSUANCE_CHECKPOINTS = [
  /** F1: acceptance committed (quote `issuing`, operation `pending`), before the inline claim. */
  "after_acceptance_commit",
  /** F2: operation claimed (`running`, generation g), before the snapshot is loaded. */
  "after_claim",
  /** F3: snapshot reloaded and its semantic hash verified, before rendering. */
  "after_snapshot_verified",
  /** F4: PDF bytes rendered, before any storage write. */
  "after_render",
  /** F5: publication temp fully written and fsync'd, before link() to the final address. */
  "before_artifact_link",
  /** F6: the final content-addressed file exists and was re-verified, before T5. */
  "after_artifact_published",
  /** F6/F10: lease still believed held (signal checked), immediately before the T5 call. */
  "before_t5",
  /** F7: inside the T5 transaction, every statement executed, before COMMIT. */
  "before_t5_commit",
  /** F8: T5 COMMIT returned COMMITTED, before the attempt reports success. */
  "after_t5_commit",
  /** F9: response rebuilt from durable state, before it is sent. */
  "before_issuance_response",
  /** F10: before each fenced lease renewal (a held renewal simulates a suspended holder). */
  "lease_renewal"
] as const;

export type IssuanceCheckpoint = (typeof ISSUANCE_CHECKPOINTS)[number];

export interface IssuanceCheckpointContext {
  readonly operationId?: string;
  readonly generation?: number;
  /** Free-form, non-sensitive detail (e.g. the temp file's base name). */
  readonly detail?: string;
}

export interface IssuanceFailpoints {
  /** Called at each checkpoint. A test implementation may block forever, exit, or return. */
  reach(checkpoint: IssuanceCheckpoint, context: IssuanceCheckpointContext): Promise<void>;
}
