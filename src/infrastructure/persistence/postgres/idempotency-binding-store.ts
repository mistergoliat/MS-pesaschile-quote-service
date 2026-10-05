import type { IdempotencyScope } from "../../../application/idempotency/idempotency-scope";
import type { SqlQueryable } from "./postgres";

export interface IdempotencyBinding extends IdempotencyScope {
  readonly requestFingerprint: string;
  readonly resourceType: "quote" | "delivery";
  readonly quoteId: string;
  readonly operationId: string | null;
  readonly deliveryId: string | null;
  readonly boundAt: string;
}

export interface NewIdempotencyBinding extends Omit<IdempotencyBinding, "boundAt"> {
  /** Full received body, immutable (idempotency contract §3.1). */
  readonly requestSnapshot: unknown;
}

interface BindingRow {
  principal_id: string;
  operation: IdempotencyScope["operation"];
  key_hash: string;
  request_fingerprint: string;
  resource_type: "quote" | "delivery";
  quote_id: string;
  operation_id: string | null;
  delivery_id: string | null;
  bound_at: Date;
}

/**
 * V2 idempotency bindings scoped by (principal, operation, SHA-256(key)).
 * The scope always comes from `idempotencyScope(authenticatedPrincipal, …)`.
 * Insert is meant to run inside the transaction that commits the bound
 * effect (invariant I-2); replay/conflict policy belongs to the caller.
 */
export class PostgresIdempotencyBindingStore {
  constructor(private readonly database: SqlQueryable) {}

  async find(scope: IdempotencyScope, queryable: SqlQueryable = this.database): Promise<IdempotencyBinding | null> {
    const result = await queryable.query<BindingRow>(
      `select principal_id, operation, key_hash, request_fingerprint, resource_type, quote_id, operation_id,
              delivery_id, bound_at
       from quote_service.idempotency_bindings
       where principal_id = $1 and operation = $2 and key_hash = $3`,
      [scope.principalId, scope.operation, scope.keyHash]
    );
    const row = result.rows[0];

    return row
      ? {
          principalId: row.principal_id,
          operation: row.operation,
          keyHash: row.key_hash,
          requestFingerprint: row.request_fingerprint,
          resourceType: row.resource_type,
          quoteId: row.quote_id,
          operationId: row.operation_id,
          deliveryId: row.delivery_id,
          boundAt: row.bound_at.toISOString()
        }
      : null;
  }

  /** Returns `already_bound` when another transaction holds the same scope. */
  async insert(queryable: SqlQueryable, binding: NewIdempotencyBinding): Promise<"bound" | "already_bound"> {
    const result = await queryable.query(
      `insert into quote_service.idempotency_bindings (
         principal_id, operation, key_hash, binding_kind, request_fingerprint, fingerprint_algorithm,
         request_snapshot, resource_type, quote_id, operation_id, delivery_id, bound_at
       ) values ($1, $2, $3, 'v2', $4, 'jcs-sha256-v2', $5, $6, $7, $8, $9, now())
       on conflict (principal_id, operation, key_hash) do nothing`,
      [
        binding.principalId,
        binding.operation,
        binding.keyHash,
        binding.requestFingerprint,
        JSON.stringify(binding.requestSnapshot),
        binding.resourceType,
        binding.quoteId,
        binding.operationId,
        binding.deliveryId
      ]
    );

    return result.rowCount === 1 ? "bound" : "already_bound";
  }
}
