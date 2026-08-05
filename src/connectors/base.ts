import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export type ConnectorType = 'rest' | 'graphql' | 'webhook' | 'database' | 'cloud';

export interface ConnectorConfig {
  name: string;
  type: ConnectorType;
  timeout: number;
  retries: number;
}

export interface ConnectorRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface ConnectorResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  duration: number;
}

/**
 * Base connector with retry + audit. Subclasses implement `request`; every
 * success and failure is written to the immutable audit trail.
 */
export abstract class BaseConnector {
  protected readonly config: ConnectorConfig;
  protected readonly audit: AuditLogger;

  constructor(config: ConnectorConfig, audit = new AuditLogger()) {
    this.config = config;
    this.audit = audit;
  }

  abstract request(req: ConnectorRequest): Promise<ConnectorResponse>;

  protected async executeWithRetries<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < this.config.retries) {
      try {
        const result = await fn();
        this.audit.logAction({
          action: 'connector_success',
          metadata: { connector: this.config.name, context, attempt: attempt + 1 },
        });
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        attempt++;
        logger.warn(
          { connector: this.config.name, context, attempt, error: lastError.message },
          'Connector attempt failed',
        );
      }
    }

    this.audit.logAction({
      action: 'connector_failure',
      metadata: {
        connector: this.config.name,
        context,
        attempts: this.config.retries,
        error: lastError?.message,
      },
    });
    throw lastError;
  }
}
