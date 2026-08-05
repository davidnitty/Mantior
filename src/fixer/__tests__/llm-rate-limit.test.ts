import { describe, expect, it, jest } from '@jest/globals';

import { LLMRateLimiter } from '../llm-rate-limit';

describe('LLMRateLimiter', () => {
  it('allows calls under the concurrency and rate limits', async () => {
    const limiter = new LLMRateLimiter({ maxConcurrent: 2, maxPerMinute: 1000 });
    await limiter.acquire();
    limiter.release();
    await limiter.acquire();
    limiter.release();
  });

  it('queues calls when the concurrency cap is reached', async () => {
    const limiter = new LLMRateLimiter({ maxConcurrent: 1, maxPerMinute: 1000 });
    await limiter.acquire();

    let acquired = false;
    const pending = limiter.acquire().then(() => {
      acquired = true;
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(acquired).toBe(false);

    limiter.release();
    await pending;
    expect(acquired).toBe(true);
    limiter.release();
  });

  it('bounds the per-minute window', async () => {
    jest.useFakeTimers();
    try {
      const limiter = new LLMRateLimiter({ maxConcurrent: 5, maxPerMinute: 2 });
      await limiter.acquire();
      limiter.release();
      await limiter.acquire();
      limiter.release();

      let acquired = false;
      const pending = limiter.acquire().then(() => {
        acquired = true;
      });
      await jest.advanceTimersByTimeAsync(80);
      expect(acquired).toBe(false); // still inside the 60s window

      await jest.advanceTimersByTimeAsync(60_000); // window slides → allowed
      await pending;
      expect(acquired).toBe(true);
      limiter.release();
    } finally {
      jest.useRealTimers();
    }
  });
});
