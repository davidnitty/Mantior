import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface RollbackPlan {
  id: string;
  operation: string;
  steps: RollbackStep[];
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export interface RollbackStep {
  id: string;
  type: 'revert' | 'restore' | 'delete' | 'notify';
  description: string;
  execute: () => Promise<void>;
  revert?: () => Promise<void>;
}

/**
 * Best-effort reverse execution: every change that is applied has a plan to
 * undo it, run in reverse order. Partial failures are collected and surfaced,
 * never silently swallowed.
 */
export class RollbackManager {
  private readonly plans = new Map<string, RollbackPlan>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  /**
   * Create a rollback plan for an operation.
   */
  createPlan(operation: string, steps: RollbackStep[]): string {
    const id = `rollback_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const plan: RollbackPlan = {
      id,
      operation,
      steps,
      status: 'pending',
      createdAt: new Date(),
    };

    this.plans.set(id, plan);

    this.audit.logAction({
      action: 'rollback_plan_created',
      metadata: {
        planId: id,
        operation,
        stepCount: steps.length,
      },
    });

    return id;
  }

  /**
   * Execute a rollback plan (steps run in reverse order, best effort).
   */
  async executePlan(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Rollback plan not found: ${planId}`);
    }

    plan.status = 'executing';
    const errors: string[] = [];

    for (let i = plan.steps.length - 1; i >= 0; i--) {
      const step = plan.steps[i];
      try {
        await step.execute();
        this.audit.logAction({
          action: 'rollback_step_executed',
          metadata: {
            planId,
            stepId: step.id,
            stepType: step.type,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Step ${step.id} failed: ${message}`);
        // Continue with other steps (best effort)
        this.audit.logAction({
          action: 'rollback_step_failed',
          metadata: {
            planId,
            stepId: step.id,
            error: message,
          },
        });
      }
    }

    plan.status = errors.length > 0 ? 'failed' : 'completed';
    plan.completedAt = new Date();

    this.audit.logAction({
      action: 'rollback_completed',
      metadata: {
        planId,
        status: plan.status,
        errors,
      },
    });

    if (errors.length > 0) {
      logger.error({ planId, errors }, 'Rollback plan finished with errors');
      throw new Error(`Rollback completed with ${errors.length} errors`);
    }
  }

  /**
   * Get a rollback plan by id.
   */
  getPlan(id: string): RollbackPlan | null {
    return this.plans.get(id) ?? null;
  }

  /**
   * List all rollback plans.
   */
  listPlans(): RollbackPlan[] {
    return Array.from(this.plans.values());
  }

  /**
   * Check if an operation has a rollback plan.
   */
  hasPlan(operation: string): boolean {
    for (const plan of this.plans.values()) {
      if (plan.operation === operation) {
        return true;
      }
    }
    return false;
  }
}

export const rollbackManager = new RollbackManager();
