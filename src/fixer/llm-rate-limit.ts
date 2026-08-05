export interface RateLimitConfig {
  maxConcurrent: number;
  maxPerMinute: number;
}

const DEFAULT_CONFIG: RateLimitConfig = { maxConcurrent: 2, maxPerMinute: 120 };

/**
 * Simple concurrency + per-minute window limiter for LLM calls. Keeps burst
 * usage (and therefore cost) predictable when many call sites need fixing.
 */
export class LLMRateLimiter {
  private readonly config: RateLimitConfig;
  private inFlight = 0;
  private timestamps: number[] = [];

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async acquire(): Promise<void> {
    let acquired = false;
    while (!acquired) {
      this.prune();
      const recent = this.timestamps.filter(timestamp => Date.now() - timestamp < 60_000).length;
      if (this.inFlight < this.config.maxConcurrent && recent < this.config.maxPerMinute) {
        this.inFlight += 1;
        this.timestamps.push(Date.now());
        acquired = true;
      } else {
        await sleep(50);
      }
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private prune(): void {
    this.timestamps = this.timestamps.filter(timestamp => Date.now() - timestamp < 60_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
