export class ApplicationLifecycleState {
  private shuttingDown = false;

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
