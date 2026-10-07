import {
  probeFailed,
  type ArtifactStorageProbePort,
  type DatabaseProbePort,
  type DatabaseProbeResult,
  type FailureCategory,
  type ProbeOutcome,
  type RendererProbePort,
  type SchemaHeadState
} from "./dependency-state";

export type ReadinessCheckName = "database" | "schema" | "artifactStorage" | "renderer" | "lifecycle";
export type CheckResult = "ok" | "fail";

export interface ReadinessSnapshot {
  readonly status: "ready" | "not_ready";
  readonly checks: Record<ReadinessCheckName, CheckResult>;
}

export interface DependencyStatusView {
  readonly status: "up" | "down" | "degraded";
  readonly failureCategory: FailureCategory | null;
  readonly lastSuccessAt: string | null;
}

export interface DependencyDetailsSnapshot {
  readonly schema: {
    readonly expectedHead: string;
    readonly actualHead: string | null;
    readonly state: SchemaHeadState | "UNKNOWN";
  };
  readonly dependencies: {
    readonly database: DependencyStatusView;
    readonly artifactStorage: DependencyStatusView;
    readonly renderer: DependencyStatusView;
  };
}

export type BusinessGateRejection =
  | {
      readonly code: "dependency_unavailable";
      readonly dependency: "lifecycle" | "database" | "artifactStorage" | "renderer";
    }
  | { readonly code: "schema_not_ready" };

export interface DependencyMonitorConfig {
  /** Probe cadence while every dependency is healthy. */
  readonly intervalMs: number;
  /** First retry delay after a failed cycle; doubles per failed cycle. */
  readonly retryMinMs: number;
  /** Upper bound of the retry backoff. */
  readonly retryMaxMs: number;
  /** Hard bound for each individual probe. */
  readonly probeTimeoutMs: number;
  readonly expectedSchemaHead: string;
  readonly now?: () => Date;
}

export interface DependencyMonitorLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface LifecycleReadinessPort {
  readonly isShuttingDown: boolean;
}

type ProbedDependency = "database" | "artifactStorage" | "renderer";

interface DependencyRecord {
  status: "unknown" | "up" | "down";
  failureCategory: FailureCategory | null;
  lastSuccessAt: string | null;
  downSinceMs: number | null;
}

function unknownRecord(): DependencyRecord {
  return {
    status: "unknown",
    failureCategory: null,
    lastSuccessAt: null,
    downSinceMs: null
  };
}

async function boundedProbe<T>(
  probe: () => Promise<T>,
  timeoutMs: number,
  onTimeout: T,
  onError: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([
      probe().catch(() => onError),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single owner of dependency readiness. Probes run on an explicit cadence
 * (bounded, single-flight); health routes, the business-route gate and the
 * background jobs only read the cached state. Only state transitions are
 * logged, so a long outage produces one `dependency.down` line, not one per poll.
 */
export class DependencyMonitor {
  private readonly records: Record<ProbedDependency, DependencyRecord> = {
    database: unknownRecord(),
    artifactStorage: unknownRecord(),
    renderer: unknownRecord()
  };
  private schemaState: SchemaHeadState | "UNKNOWN" = "UNKNOWN";
  private schemaActualHead: string | null = null;
  private lastReady: boolean | null = null;
  private consecutiveFailedCycles = 0;
  private lastCycleStartedAtMs = 0;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly now: () => Date;

  constructor(
    private readonly ports: {
      readonly database: DatabaseProbePort;
      readonly artifactStorage: ArtifactStorageProbePort;
      readonly renderer: RendererProbePort;
    },
    private readonly lifecycle: LifecycleReadinessPort,
    private readonly config: DependencyMonitorConfig,
    private readonly logger: DependencyMonitorLogger
  ) {
    this.now = config.now ?? (() => new Date());
  }

  /** Runs one probe cycle, joining the in-flight cycle if there is one. Never rejects. */
  probeNow(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  /**
   * Hint that a dependency just failed outside a probe (e.g. a request saw a
   * connection error). Throttled to one extra cycle per `retryMinMs`.
   */
  requestProbe(): void {
    if (this.inFlight || Date.now() - this.lastCycleStartedAtMs < this.config.retryMinMs) {
      return;
    }

    void this.probeNow();
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.inFlight;
  }

  isReady(): boolean {
    return this.readiness().status === "ready";
  }

  /**
   * Database reachable, schema at the expected head and not shutting down:
   * enough for database-only work (the issuance deadline sweep), which must
   * not pause during a storage or renderer outage. Never used for `/health/ready`.
   */
  isPersistenceReady(): boolean {
    return !this.lifecycle.isShuttingDown && this.records.database.status === "up" && this.schemaState === "READY";
  }

  readiness(): ReadinessSnapshot {
    const checks: Record<ReadinessCheckName, CheckResult> = {
      database: this.records.database.status === "up" ? "ok" : "fail",
      schema: this.schemaState === "READY" ? "ok" : "fail",
      artifactStorage: this.records.artifactStorage.status === "up" ? "ok" : "fail",
      renderer: this.records.renderer.status === "up" ? "ok" : "fail",
      lifecycle: this.lifecycle.isShuttingDown ? "fail" : "ok"
    };

    return {
      status: Object.values(checks).every((check) => check === "ok") ? "ready" : "not_ready",
      checks
    };
  }

  /** First failing requirement in a fixed order, or null when business traffic may proceed. */
  businessGate(): BusinessGateRejection | null {
    if (this.lifecycle.isShuttingDown) {
      return { code: "dependency_unavailable", dependency: "lifecycle" };
    }

    if (this.records.database.status !== "up") {
      return { code: "dependency_unavailable", dependency: "database" };
    }

    if (this.schemaState !== "READY") {
      return { code: "schema_not_ready" };
    }

    if (this.records.artifactStorage.status !== "up") {
      return { code: "dependency_unavailable", dependency: "artifactStorage" };
    }

    if (this.records.renderer.status !== "up") {
      return { code: "dependency_unavailable", dependency: "renderer" };
    }

    return null;
  }

  details(): DependencyDetailsSnapshot {
    const database = this.records.database;

    return {
      schema: {
        expectedHead: this.config.expectedSchemaHead,
        actualHead: this.schemaActualHead,
        state: this.schemaState
      },
      dependencies: {
        database:
          database.status === "up" && this.schemaState !== "READY"
            ? {
                status: "degraded",
                failureCategory:
                  this.schemaState === "SCHEMA_INTEGRITY_MISMATCH" ||
                  this.schemaState === "SCHEMA_INTEGRITY_UNVERIFIED"
                    ? "integrity"
                    : "schema_mismatch",
                lastSuccessAt: database.lastSuccessAt
              }
            : this.toView(database),
        artifactStorage: this.toView(this.records.artifactStorage),
        renderer: this.toView(this.records.renderer)
      }
    };
  }

  private toView(record: DependencyRecord): DependencyStatusView {
    return {
      status: record.status === "up" ? "up" : "down",
      failureCategory: record.failureCategory,
      lastSuccessAt: record.lastSuccessAt
    };
  }

  private scheduleNext(): void {
    if (!this.started) {
      return;
    }

    const delay =
      this.consecutiveFailedCycles === 0
        ? this.config.intervalMs
        : Math.min(
            this.config.retryMaxMs,
            this.config.retryMinMs * 2 ** Math.min(this.consecutiveFailedCycles - 1, 16)
          );

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.probeNow().then(() => {
        this.scheduleNext();
      });
    }, delay);
    this.timer.unref();
  }

  private async runCycle(): Promise<void> {
    this.lastCycleStartedAtMs = Date.now();
    const timeoutMs = this.config.probeTimeoutMs;
    const databaseFailure = (failureCategory: FailureCategory): DatabaseProbeResult => ({
      connection: probeFailed(failureCategory),
      schema: {
        state: "DB_UNAVAILABLE",
        actualHead: null
      }
    });

    const [database, artifactStorage, renderer] = await Promise.all([
      boundedProbe(
        () => this.ports.database.probe(timeoutMs),
        timeoutMs,
        databaseFailure("timeout"),
        databaseFailure("unreachable")
      ),
      boundedProbe(
        () => this.ports.artifactStorage.probe(),
        timeoutMs,
        probeFailed("timeout"),
        probeFailed("unreachable")
      ),
      boundedProbe(
        () => this.ports.renderer.probe(),
        timeoutMs,
        probeFailed("renderer_unavailable"),
        probeFailed("renderer_unavailable")
      )
    ]);
    const nowDate = this.now();

    this.applyOutcome("database", database.connection, nowDate);
    this.applySchema(database.connection.ok ? database.schema : { state: "DB_UNAVAILABLE", actualHead: null });
    this.applyOutcome("artifactStorage", artifactStorage, nowDate);
    this.applyOutcome("renderer", renderer, nowDate);

    const allDependenciesOk =
      database.connection.ok && database.schema.state === "READY" && artifactStorage.ok && renderer.ok;
    this.consecutiveFailedCycles = allDependenciesOk ? 0 : this.consecutiveFailedCycles + 1;
    this.logReadinessTransition();
  }

  private applyOutcome(name: ProbedDependency, outcome: ProbeOutcome, nowDate: Date): void {
    const record = this.records[name];
    const previousStatus = record.status;
    const previousCategory = record.failureCategory;

    if (outcome.ok) {
      record.status = "up";
      record.failureCategory = null;
      record.lastSuccessAt = nowDate.toISOString();

      if (previousStatus === "down") {
        this.logger.info(
          {
            event: "dependency.recovered",
            dependency: name,
            downForMs: record.downSinceMs === null ? null : nowDate.getTime() - record.downSinceMs
          },
          "Dependency recovered"
        );
      }

      record.downSinceMs = null;
      return;
    }

    record.status = "down";
    record.failureCategory = outcome.failureCategory;

    if (previousStatus !== "down") {
      record.downSinceMs = nowDate.getTime();
    }

    if (previousStatus !== "down" || previousCategory !== outcome.failureCategory) {
      this.logger.warn(
        {
          event: "dependency.down",
          dependency: name,
          failureCategory: outcome.failureCategory
        },
        "Dependency unavailable"
      );
    }
  }

  private applySchema(schema: DatabaseProbeResult["schema"]): void {
    const previousState = this.schemaState;
    const previousHead = this.schemaActualHead;
    this.schemaState = schema.state;

    // Keep the last observed head while the database is unreachable; the
    // schema itself did not change just because we cannot see it.
    if (schema.state !== "DB_UNAVAILABLE") {
      this.schemaActualHead = schema.actualHead;
    }

    if (schema.state === "DB_UNAVAILABLE") {
      return;
    }

    if (schema.state === "READY") {
      if (previousState !== "READY" && previousState !== "UNKNOWN" && previousState !== "DB_UNAVAILABLE") {
        this.logger.info(
          {
            event: "dependency.recovered",
            dependency: "schema",
            actualHead: schema.actualHead
          },
          "Schema reached expected head"
        );
      }

      return;
    }

    if (previousState !== schema.state || previousHead !== schema.actualHead) {
      this.logger.warn(
        {
          event: "schema.not_ready",
          state: schema.state,
          expectedHead: this.config.expectedSchemaHead,
          actualHead: schema.actualHead
        },
        "Database schema is not at the expected migration head"
      );
    }
  }

  private logReadinessTransition(): void {
    const snapshot = this.readiness();
    const ready = snapshot.status === "ready";

    if (this.lastReady === ready) {
      return;
    }

    this.lastReady = ready;

    if (ready) {
      this.logger.info({ event: "runtime.ready" }, "Runtime is ready");
      return;
    }

    this.logger.warn(
      {
        event: "runtime.unready",
        failing: Object.entries(snapshot.checks)
          .filter(([, result]) => result === "fail")
          .map(([name]) => name)
      },
      "Runtime is not ready"
    );
  }
}
