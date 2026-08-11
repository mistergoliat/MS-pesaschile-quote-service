import type { DatabaseHealthStatus } from "../ports/database-health-port";

export interface DependencyReadinessStatus {
  readonly status: "up" | "down";
  readonly details?: string;
}

export interface ReadinessCheckResult {
  readonly status: "ready" | "not_ready";
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
  readonly checks: {
    readonly lifecycle: {
      readonly status: "up" | "down";
      readonly phase: "running" | "shutting_down";
    };
    readonly database: DatabaseHealthStatus;
    readonly storage: DependencyReadinessStatus;
    readonly pdfRenderer: DependencyReadinessStatus;
  };
}

export interface ReadinessServiceConfig {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly databaseTimeoutMs: number;
}

export interface DatabaseReadinessPort {
  checkHealth(timeoutMs: number): Promise<DatabaseHealthStatus>;
}

export interface StorageReadinessPort {
  checkReadiness(): Promise<DependencyReadinessStatus>;
}

export interface PdfRendererReadinessPort {
  checkReadiness(): Promise<DependencyReadinessStatus>;
}

export interface LifecycleReadinessPort {
  readonly isShuttingDown: boolean;
}

export class ReadinessService {
  constructor(
    private readonly database: DatabaseReadinessPort,
    private readonly storage: StorageReadinessPort,
    private readonly pdfRenderer: PdfRendererReadinessPort,
    private readonly lifecycle: LifecycleReadinessPort,
    private readonly config: ReadinessServiceConfig
  ) {}

  async check(now: Date): Promise<ReadinessCheckResult> {
    const [database, storage, pdfRenderer] = await Promise.all([
      this.database.checkHealth(this.config.databaseTimeoutMs),
      this.storage.checkReadiness(),
      this.pdfRenderer.checkReadiness()
    ]);
    const lifecycle = this.lifecycle.isShuttingDown
      ? {
          status: "down" as const,
          phase: "shutting_down" as const
        }
      : {
          status: "up" as const,
          phase: "running" as const
        };

    return {
      status:
        lifecycle.status === "up" &&
        database.status === "up" &&
        storage.status === "up" &&
        pdfRenderer.status === "up"
          ? "ready"
          : "not_ready",
      service: this.config.serviceName,
      version: this.config.serviceVersion,
      timestamp: now.toISOString(),
      checks: {
        lifecycle,
        database,
        storage,
        pdfRenderer
      }
    };
  }
}
