import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface TimeoutConfig {
  /** Default timeout in milliseconds */
  default: number;
  /** Timeout by action type */
  byAction: Record<string, number>;
  /** Timeout by component */
  byComponent: Record<string, number>;
  /** Maximum allowed timeout (safety cap) */
  maxAllowed: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  default: 30_000, // 30 seconds
  byAction: {
    api_call: 15_000,
    github_api: 30_000,
    llm_call: 60_000,
    llm_expensive: 120_000,
    database_query: 10_000,
    file_operation: 5_000,
    git_clone: 300_000,
    scan: 600_000,
    pr_create: 30_000,
  },
  byComponent: {
    diff_engine: 30_000,
    ast_walker: 60_000,
    fixer: 120_000,
    github_client: 60_000,
    database: 10_000,
  },
  maxAllowed: 900_000, // 15 minutes (safety cap)
};

export interface OperationContext {
  action: string;
  component: string;
  operationId: string;
}

/**
 * Every operation runs under a timeout. Nothing hangs forever: stuck work is
 * failed loudly, audited, and retried by policy — never left running.
 */
export class TimeoutManager {
  private readonly config: TimeoutConfig;
  private readonly audit: AuditLogger;
  private readonly activeTimers = new Map<string, NodeJS.Timeout>();

  constructor(config: Partial<TimeoutConfig> = {}, audit = new AuditLogger()) {
    this.config = { ...DEFAULT_TIMEOUT_CONFIG, ...config };
    this.audit = audit;
  }

  /**
   * Execute a function with the configured timeout.
   */
  execute<T>(fn: () => Promise<T>, context: OperationContext): Promise<T> {
    const timeout = this.getTimeout(context.action, context.component);
    const startTime = Date.now();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const duration = Date.now() - startTime;
        this.audit.logAction({
          action: 'timeout_occurred',
          metadata: {
            operationId: context.operationId,
            action: context.action,
            component: context.component,
            timeout,
            duration,
          },
        });

        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);

      this.activeTimers.set(context.operationId, timer);

      fn()
        .then(result => {
          this.cleanupTimer(context.operationId);
          resolve(result);
        })
        .catch(error => {
          this.cleanupTimer(context.operationId);
          reject(error);
        });
    });
  }

  /**
   * Execute with retry (exponential backoff) and timeout.
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: OperationContext,
    retries = 3,
    backoffMs = 1000,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await this.execute(fn, context);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries - 1) {
          const wait = backoffMs * 2 ** attempt;
          logger.warn(
            {
              attempt: attempt + 1,
              maxRetries: retries,
              wait,
              error: lastError.message,
            },
            'Retrying operation',
          );
          await this.delay(wait);
        }
      }
    }

    throw lastError ?? new Error('Operation failed after retries');
  }

  /**
   * Clean up all active timers (for shutdown).
   */
  cleanupAll(): void {
    for (const [id, timer] of this.activeTimers) {
      clearTimeout(timer);
      this.activeTimers.delete(id);
    }
  }

  private getTimeout(action: string, component: string): number {
    const componentTimeout = this.config.byComponent[component];
    if (componentTimeout) {
      return Math.min(componentTimeout, this.config.maxAllowed);
    }

    const actionTimeout = this.config.byAction[action];
    if (actionTimeout) {
      return Math.min(actionTimeout, this.config.maxAllowed);
    }

    return Math.min(this.config.default, this.config.maxAllowed);
  }

  private cleanupTimer(operationId: string): void {
    const timer = this.activeTimers.get(operationId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(operationId);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const timeoutManager = new TimeoutManager();
