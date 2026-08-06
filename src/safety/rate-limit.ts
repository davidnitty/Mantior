import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface RateLimitConfig {
  window: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
}

export interface RateLimitContext {
  key: string; // Unique identifier (user, IP, etc.)
  action: string; // What action is being rate limited
  limit: RateLimitConfig;
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

/**
 * Sliding fixed-window rate limiting in memory. Hard caps on every external
 * surface prevent a misbehaving automation (or a compromised caller) from
 * amplifying itself into an outage or an open-ended bill.
 */
export class RateLimiter {
  private readonly store = new Map<string, RateLimitRecord>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  /**
   * Check if a request is allowed (and consume one unit when allowed).
   */
  allow(context: RateLimitContext): { allowed: boolean; remaining: number; resetIn: number } {
    const key = `${context.key}:${context.action}`;
    const now = Date.now();

    let record = this.store.get(key);

    if (!record || now > record.resetAt) {
      record = {
        count: 0,
        resetAt: now + context.limit.window,
      };
    }

    const remaining = context.limit.maxRequests - record.count;

    if (remaining <= 0) {
      this.audit.logAction({
        action: 'rate_limit_exceeded',
        metadata: {
          key: context.key,
          action: context.action,
          limit: context.limit.maxRequests,
          window: context.limit.window,
        },
      });

      return {
        allowed: false,
        remaining: 0,
        resetIn: record.resetAt - now,
      };
    }

    record.count++;
    this.store.set(key, record);

    this.cleanup();

    return {
      allowed: true,
      remaining: remaining - 1,
      resetIn: record.resetAt - now,
    };
  }

  /**
   * Get current usage for a key/action.
   */
  getUsage(key: string, action: string): { count: number; limit: number; remaining: number } {
    const record = this.store.get(`${key}:${action}`);
    const limit = 100; // Default limit
    if (!record) {
      return { count: 0, limit, remaining: limit };
    }

    return {
      count: record.count,
      limit,
      remaining: limit - record.count,
    };
  }

  /**
   * Reset the rate limit for a key/action.
   */
  reset(key: string, action: string): void {
    this.store.delete(`${key}:${action}`);
  }

  /**
   * Clean up expired records.
   */
  private cleanup(): void {
    const now = Date.now();
    let expired = 0;

    for (const [key, record] of this.store) {
      if (now > record.resetAt) {
        this.store.delete(key);
        expired++;
      }
    }

    if (expired > 100) {
      logger.debug({ expired }, 'Rate limit store cleanup');
    }
  }
}

// ──────────────────────────────────────────────
// DEFAULT RATE LIMITS
// ──────────────────────────────────────────────

export const DEFAULT_RATE_LIMITS = {
  api: { window: 60_000, maxRequests: 60 }, // 60 per minute
  apiBurst: { window: 1_000, maxRequests: 5 }, // 5 per second

  github: { window: 60_000, maxRequests: 30 }, // 30 per minute
  githubPr: { window: 60_000, maxRequests: 10 }, // 10 PRs per minute

  scan: { window: 60_000, maxRequests: 3 }, // 3 scans per minute
  scanLarge: { window: 3_600_000, maxRequests: 5 }, // 5 large scans per hour

  llm: { window: 60_000, maxRequests: 50 }, // 50 LLM calls per minute
  llmExpensive: { window: 3_600_000, maxRequests: 10 }, // 10 expensive LLM calls per hour

  webhook: { window: 60_000, maxRequests: 100 }, // 100 webhooks per minute
};

export const rateLimiter = new RateLimiter();
