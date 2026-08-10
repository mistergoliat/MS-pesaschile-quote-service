export interface DatabaseHealthStatus {
  status: "up" | "down";
  latencyMs: number;
}

export interface DatabaseHealthPort {
  checkHealth(timeoutMs: number): Promise<DatabaseHealthStatus>;
}
