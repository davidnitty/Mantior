import { z } from 'zod';

import { AuditLogger } from '../audit/logger';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: unknown;
}

/**
 * Schema validation + sanitization. Garbage and hostile input never reaches
 * the engine: every external boundary (config, PR payload, webhooks, scans)
 * is validated here before it becomes an action.
 */
export class InputValidator {
  private readonly schemas = new Map<string, z.ZodTypeAny>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
    this.loadSchemas();
  }

  /**
   * Validate input against a named schema.
   */
  validate(schemaName: string, input: unknown): ValidationResult {
    const schema = this.schemas.get(schemaName);
    if (!schema) {
      return {
        valid: false,
        errors: [`Schema not found: ${schemaName}`],
      };
    }

    try {
      const result: unknown = schema.parse(input);

      this.audit.logAction({
        action: 'input_validated',
        metadata: {
          schemaName,
          success: true,
        },
      });

      return {
        valid: true,
        errors: [],
        sanitized: result,
      };
    } catch (error) {
      const errors =
        error instanceof z.ZodError
          ? error.errors.map(issue => issue.message)
          : [error instanceof Error ? error.message : String(error)];

      this.audit.logAction({
        action: 'input_validation_failed',
        metadata: {
          schemaName,
          errors,
        },
      });

      return {
        valid: false,
        errors,
      };
    }
  }

  /**
   * Sanitize input: strip dangerous characters, limit length.
   */
  sanitize(input: string): string {
    return input
      .replace(/[<>&'"]/g, '')
      .trim()
      .slice(0, 10000);
  }

  /**
   * Validate a file path (prevent path traversal).
   */
  validatePath(path: string): boolean {
    if (path.includes('..')) {
      return false;
    }
    if (path.includes('/./')) {
      return false;
    }
    if (path.includes('//')) {
      return false;
    }
    return true;
  }

  /**
   * Validate a URL (prevent SSRF against internal/link-local hosts).
   */
  validateURL(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      const hostname = parsed.hostname.toLowerCase();
      if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname)) {
        return false;
      }
      if (hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
        return false;
      }
      if (hostname.startsWith('169.254.')) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate a GitHub repository name (owner/repo).
   */
  validateRepoName(repo: string): boolean {
    return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
  }

  /**
   * Add a custom schema.
   */
  addSchema(name: string, schema: z.ZodTypeAny): void {
    this.schemas.set(name, schema);
  }

  private loadSchemas(): void {
    // API Configuration Schema
    this.schemas.set(
      'api-config',
      z.object({
        name: z.string().min(1).max(100),
        spec: z.string().min(1),
        reference_url: z.string().url(),
        consumers: z.array(
          z.object({
            repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
            branch: z.string().min(1),
            language: z.enum(['typescript', 'python', 'go', 'java', 'ruby']),
          }),
        ),
      }),
    );

    // PR Creation Schema
    this.schemas.set(
      'pr-create',
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(10000),
        branch: z.string().regex(/^[a-zA-Z0-9\-_/]+$/),
        base: z.string().regex(/^[a-zA-Z0-9\-_/]+$/),
        labels: z.array(z.string()).max(10).optional(),
        reviewers: z.array(z.string()).max(10).optional(),
      }),
    );

    // Webhook Schema
    this.schemas.set(
      'webhook',
      z.object({
        url: z.string().url(),
        events: z.array(z.string()),
        secret: z.string().min(20),
      }),
    );

    // Scan Request Schema
    this.schemas.set(
      'scan-request',
      z.object({
        config_path: z.string().min(1),
        dry_run: z.boolean().default(false),
        auto_pr: z.boolean().default(false),
        max_changes: z.number().int().positive().max(1000).default(100),
      }),
    );

    // Environment Variables Schema
    this.schemas.set('env-vars', z.record(z.string(), z.string().min(1)));
  }
}

export const inputValidator = new InputValidator();
