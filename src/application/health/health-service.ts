import type {
  DatabaseHealthPort,
  DatabaseHealthStatus
} from "../ports/database-health-port";

export interface HealthServiceConfig {
  serviceName: string;
  serviceVersion: string;
  databaseTimeoutMs: number;
}

export interface HealthCheckResult {
  status: "ok" | "degraded";
  service: string;
  version: string;
  timestamp: string;
  checks: {
    database: DatabaseHealthStatus;
  };
}

export class HealthService {
  public constructor(
    private readonly databaseHealth: DatabaseHealthPort,
    private readonly config: HealthServiceConfig
  ) {}

  public async check(now: Date): Promise<HealthCheckResult> {
    const database = await this.databaseHealth.checkHealth(
      this.config.databaseTimeoutMs
    );

    return {
      status: database.status === "up" ? "ok" : "degraded",
      service: this.config.serviceName,
      version: this.config.serviceVersion,
      timestamp: now.toISOString(),
      checks: {
        database
      }
    };
  }
}
