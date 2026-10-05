/**
 * Sanitized dependency vocabulary shared by the dependency monitor, its probe
 * adapters and the health routes. Values match the frozen V2 contract
 * (`DependencyStatus.failureCategory` in docs/v2/openapi.yaml).
 */
export type FailureCategory =
  | "unreachable"
  | "timeout"
  | "authentication"
  | "permission"
  | "schema_mismatch"
  | "storage_full"
  | "storage_read_only"
  | "integrity"
  | "renderer_unavailable"
  | "provider_error";

export type SchemaHeadState =
  | "READY"
  | "SCHEMA_MISSING"
  | "SCHEMA_BEHIND"
  | "SCHEMA_AHEAD_OR_UNKNOWN"
  // At the expected head, but an applied migration's recorded checksum
  // differs from the packaged file (same name, changed bytes).
  | "SCHEMA_INTEGRITY_MISMATCH"
  // At the expected head, but some applied migration has no recorded checksum.
  | "SCHEMA_INTEGRITY_UNVERIFIED"
  | "DB_UNAVAILABLE";

export type ProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureCategory: FailureCategory };

export interface DatabaseProbeResult {
  readonly connection: ProbeOutcome;
  readonly schema: {
    readonly state: SchemaHeadState;
    readonly actualHead: string | null;
  };
}

export interface DatabaseProbePort {
  probe(timeoutMs: number): Promise<DatabaseProbeResult>;
}

export interface ArtifactStorageProbePort {
  probe(): Promise<ProbeOutcome>;
}

export interface RendererProbePort {
  probe(): Promise<ProbeOutcome>;
}

export const PROBE_OK: ProbeOutcome = { ok: true };

export function probeFailed(failureCategory: FailureCategory): ProbeOutcome {
  return {
    ok: false,
    failureCategory
  };
}
