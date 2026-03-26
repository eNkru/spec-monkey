export class Heartbeat {
  private intervalSeconds: number;
  private taskTitle: string = '';
  private startTime: number = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;

  constructor(intervalSeconds: number) {
    this.intervalSeconds = intervalSeconds;
  }

  start(taskTitle: string): void {
    this.taskTitle = taskTitle;
    this.startTime = Date.now();
    this.timerId = setInterval(() => this.tick(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  tick(): void {
    const elapsed = this.getElapsedSeconds();
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    const formatted = `${minutes}m ${seconds}s`;
    process.stderr.write(`[heartbeat] Task: ${this.taskTitle} | Elapsed: ${formatted} | streaming...\n`);
  }

  getElapsedSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }
}
