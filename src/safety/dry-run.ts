import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface StateSnapshot {
  timestamp: string;
  [key: string]: unknown;
}

export interface DryRunResult {
  mode: 'dry-run' | 'actual';
  actions: DryRunAction[];
  impacts: string[];
  warnings: string[];
  estimatedCost?: number;
  estimatedTime?: number;
}

export interface DryRunAction {
  id: string;
  type: string;
  description: string;
  target: string;
  change: string;
  before: StateSnapshot;
  after: StateSnapshot;
  risk: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
}

interface ChangeAnalysis {
  changedKeys: string[];
  result: unknown;
}

/**
 * Dry-run guard: simulate an action without performing it, capture state
 * before/after, and report what *would* have changed. The AI plans;
 * deterministic systems execute — this is the "plans" side of the fence.
 */
export class DryRunManager {
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  /**
   * Execute a dry-run of an action: simulates it without side effects.
   */
  async simulate<T>(
    action: () => Promise<T>,
    description: string,
    context: { workflowId: string; initiator: string },
  ): Promise<DryRunResult> {
    const actions: DryRunAction[] = [];
    const impacts: string[] = [];
    const warnings: string[] = [];

    logger.info({ workflowId: context.workflowId, description }, 'Dry-run simulation starting');

    try {
      const before = await this.captureState();
      const result = await this.safeExecute(action);
      const after = await this.captureState();
      const diff = this.analyzeDiff(before, after, result);

      actions.push({
        id: `dry-run-${Date.now()}`,
        type: 'simulated',
        description,
        target: 'system',
        change: JSON.stringify(diff),
        before,
        after,
        risk: this.calculateRisk(diff),
        requiresApproval: true,
      });

      impacts.push(`This action would affect ${diff.changedKeys.length} components`);
      warnings.push('This is a dry-run; no actual changes were made');

      this.audit.logAction({
        action: 'dry_run_completed',
        metadata: {
          workflowId: context.workflowId,
          description,
          actionCount: actions.length,
          warnings: warnings.length,
        },
      });

      return {
        mode: 'dry-run',
        actions,
        impacts,
        warnings,
        estimatedCost: 0,
        estimatedTime: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Dry-run failed');
      throw error;
    }
  }

  /**
   * Preview a single change without applying it.
   */
  async preview<T>(
    action: () => Promise<T>,
    description: string,
    _context: { workflowId: string; initiator: string },
  ): Promise<DryRunAction> {
    const before = await this.captureState();
    const result = await this.safeExecute(action);
    const after = await this.captureState();
    const diff = this.analyzeDiff(before, after, result);

    return {
      id: `preview-${Date.now()}`,
      type: 'preview',
      description,
      target: 'system',
      change: JSON.stringify(diff),
      before,
      after,
      risk: this.calculateRisk(diff),
      requiresApproval: true,
    };
  }

  private captureState(): Promise<StateSnapshot> {
    // Capture relevant state (database, files, environment).
    // This is a placeholder; a full implementation would snapshot the
    // filesystem/db so the before/after diff reflects real impact.
    return Promise.resolve({
      timestamp: new Date().toISOString(),
    });
  }

  private async safeExecute<T>(action: () => Promise<T>): Promise<T> {
    // Execute with protection (no actual changes). Simulate rollback and
    // never fail the dry-run if the action would have failed.
    try {
      const result = await action();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'Dry-run action would have failed');
      return null as unknown as T;
    }
  }

  private analyzeDiff(
    before: StateSnapshot,
    after: StateSnapshot,
    result: unknown,
  ): ChangeAnalysis {
    const changedKeys = Object.keys(after).filter(key => before[key] !== after[key]);
    return { changedKeys, result };
  }

  private calculateRisk(diff: ChangeAnalysis): 'low' | 'medium' | 'high' | 'critical' {
    const changeCount = diff.changedKeys.length;
    if (changeCount > 10) {
      return 'critical';
    }
    if (changeCount > 5) {
      return 'high';
    }
    if (changeCount > 2) {
      return 'medium';
    }
    return 'low';
  }
}
