import type { SpecMonkeyConfig } from '../config/index.js';

export interface AttemptResult {
  madeProgress: boolean;   // true if files changed or gate passed
  errorPattern?: string;   // the error string/pattern if the attempt ended in error
}

export class CircuitBreaker {
  private readonly config: SpecMonkeyConfig;
  private tripped = false;
  private reason = '';
  private noProgressCount = 0;
  private repeatedErrorCount = 0;
  private lastErrorPattern: string | undefined = undefined;

  constructor(config: SpecMonkeyConfig) {
    this.config = config;
  }

  recordAttempt(result: AttemptResult): void {
    const cb = this.config.circuit_breaker;

    // Track no-progress counter
    if (result.madeProgress) {
      this.noProgressCount = 0;
    } else {
      this.noProgressCount++;
      if (this.noProgressCount >= cb.no_progress_threshold) {
        this.tripped = true;
        this.reason = `Circuit breaker opened: ${this.noProgressCount} consecutive attempts made no progress (threshold: ${cb.no_progress_threshold})`;
      }
    }

    // Track repeated-error counter
    if (result.errorPattern !== undefined) {
      if (result.errorPattern === this.lastErrorPattern) {
        this.repeatedErrorCount++;
        if (this.repeatedErrorCount >= cb.repeated_error_threshold) {
          this.tripped = true;
          this.reason = `Circuit breaker opened: error pattern "${result.errorPattern}" repeated ${this.repeatedErrorCount} times (threshold: ${cb.repeated_error_threshold})`;
        }
      } else {
        this.lastErrorPattern = result.errorPattern;
        this.repeatedErrorCount = 1;
      }
    } else {
      this.lastErrorPattern = undefined;
      this.repeatedErrorCount = 0;
    }
  }

  async recordRateLimit(logContent: string): Promise<void> {
    const cb = this.config.circuit_breaker;
    const lower = logContent.toLowerCase();
    const matched = cb.rate_limit_patterns.some(pattern => lower.includes(pattern.toLowerCase()));
    if (matched) {
      await new Promise<void>(r => setTimeout(r, cb.rate_limit_cooldown * 1000));
    }
  }

  isTripped(): boolean {
    return this.tripped;
  }

  getReason(): string {
    return this.reason;
  }

  reset(): void {
    this.tripped = false;
    this.reason = '';
    this.noProgressCount = 0;
    this.repeatedErrorCount = 0;
    this.lastErrorPattern = undefined;
  }
}
