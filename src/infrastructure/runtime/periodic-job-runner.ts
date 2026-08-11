type JobLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

export interface PeriodicJobRunnerConfig {
  readonly name: string;
  readonly intervalMs: number;
  readonly logger: JobLogger;
  readonly execute: () => Promise<void>;
}

export class PeriodicJobRunner {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private currentRun: Promise<void> | null = null;

  constructor(private readonly config: PeriodicJobRunnerConfig) {}

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

    await this.currentRun;
  }

  async runNow(): Promise<void> {
    if (this.currentRun) {
      await this.currentRun;
      return;
    }

    this.currentRun = this.executeSafely();

    try {
      await this.currentRun;
    } finally {
      this.currentRun = null;
    }
  }

  private scheduleNext(): void {
    if (!this.started) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runNow().finally(() => {
        this.scheduleNext();
      });
    }, this.config.intervalMs);
    this.timer.unref();
  }

  private async executeSafely(): Promise<void> {
    try {
      await this.config.execute();
    } catch (error) {
      this.config.logger.error(
        {
          job: this.config.name,
          error: error instanceof Error ? error.message : "unknown"
        },
        "Background job iteration failed"
      );
    }
  }
}
