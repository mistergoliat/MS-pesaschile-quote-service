import { safeErrorSummary } from "../../application/safe-error";

type JobLogger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
};

export interface PeriodicJobRunnerConfig {
  readonly name: string;
  readonly intervalMs: number;
  readonly logger: JobLogger;
  readonly execute: () => Promise<void>;
  /**
   * Checked before every iteration. When false the iteration is skipped (not
   * failed): jobs never run against an unready dependency set.
   */
  readonly canRun?: () => boolean;
}

export interface PeriodicJobStatus {
  readonly lastPollAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastIterationFailed: boolean;
}

export class PeriodicJobRunner {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private currentRun: Promise<void> | null = null;
  private paused = false;
  private lastPollAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastIterationFailed = false;

  constructor(private readonly config: PeriodicJobRunnerConfig) {}

  get status(): PeriodicJobStatus {
    return {
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastIterationFailed: this.lastIterationFailed
    };
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
    if (this.config.canRun && !this.config.canRun()) {
      if (!this.paused) {
        this.paused = true;
        this.config.logger.warn(
          { event: "job.paused", job: this.config.name, reason: "dependencies_unready" },
          "Background job paused until dependencies are ready"
        );
      }

      return;
    }

    if (this.paused) {
      this.paused = false;
      this.config.logger.info(
        { event: "job.resumed", job: this.config.name },
        "Background job resumed"
      );
    }

    this.lastPollAt = new Date().toISOString();

    try {
      await this.config.execute();
      this.lastSuccessAt = this.lastPollAt;
      this.lastIterationFailed = false;
    } catch (error) {
      this.lastIterationFailed = true;
      // Name and driver code only: driver messages can echo row values.
      this.config.logger.error(
        {
          event: "job.failed",
          job: this.config.name,
          ...safeErrorSummary(error)
        },
        "Background job iteration failed"
      );
    }
  }
}
