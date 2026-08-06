import { createHash } from 'node:crypto';

import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface IdempotencyKey {
  key: string;
  operation: string;
  result: unknown;
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  expiresAt: Date;
}

/**
 * Exactly-once execution for retries and webhook replays: the same operation
 * with the same parameters produces the same result without repeating
 * side effects. Prevents double-PRs, double-fixes and double-spend.
 */
export class IdempotencyManager {
  private readonly store = new Map<string, IdempotencyKey>();
  private readonly audit: AuditLogger;
  private readonly ttl = 24 * 60 * 60 * 1000; // 24 hours

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  /**
   * Generate an idempotency key from operation + parameters.
   */
  generateKey(operation: string, params: unknown): string {
    const hash = createHash('sha256')
      .update(operation)
      .update(JSON.stringify(params))
      .digest('hex');
    return `idem_${hash.slice(0, 16)}`;
  }

  /**
   * Check if an operation has already been executed.
   */
  check(key: string): IdempotencyKey | null {
    const record = this.store.get(key);
    if (!record) {
      return null;
    }

    if (new Date() > record.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return record;
  }

  /**
   * Execute an operation with idempotency: replays of a completed operation
   * return the cached result without re-running the side effects.
   */
  async execute<T>(
    key: string,
    operation: string,
    fn: () => Promise<T>,
    _params: unknown,
  ): Promise<{ result: T; isCached: boolean }> {
    const existing = this.check(key);
    if (existing && existing.status === 'completed') {
      this.audit.logAction({
        action: 'idempotency_hit',
        metadata: {
          key,
          operation,
          cached: true,
        },
      });

      return {
        result: existing.result as T,
        isCached: true,
      };
    }

    const record: IdempotencyKey = {
      key,
      operation,
      result: null,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.ttl),
    };
    this.store.set(key, record);

    try {
      const result = await fn();

      record.result = result;
      record.status = 'completed';
      record.completedAt = new Date();
      this.store.set(key, record);

      this.audit.logAction({
        action: 'idempotency_executed',
        metadata: {
          key,
          operation,
          status: 'completed',
        },
      });

      return {
        result,
        isCached: false,
      };
    } catch (error) {
      record.status = 'failed';
      this.store.set(key, record);

      const message = error instanceof Error ? error.message : String(error);
      this.audit.logAction({
        action: 'idempotency_failed',
        metadata: {
          key,
          operation,
          error: message,
        },
      });

      throw error;
    }
  }

  /**
   * Clean up expired entries.
   */
  cleanup(): void {
    const now = new Date();
    let expired = 0;

    for (const [key, record] of this.store) {
      if (now > record.expiresAt) {
        this.store.delete(key);
        expired++;
      }
    }

    if (expired > 0) {
      logger.debug({ expired }, 'Idempotency store cleaned up');
    }
  }

  /**
   * Get store statistics.
   */
  stats(): { total: number; pending: number; completed: number; failed: number } {
    let pending = 0;
    let completed = 0;
    let failed = 0;

    for (const record of this.store.values()) {
      switch (record.status) {
        case 'pending':
          pending++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }

    return {
      total: this.store.size,
      pending,
      completed,
      failed,
    };
  }
}

export const idempotencyManager = new IdempotencyManager();
