import { EventEmitter } from 'node:events';

import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';
import { metrics, recordWorkflowMetrics } from '../monitoring/metrics';
import { tracer } from '../monitoring/traces';

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export interface WorkflowStep {
  id: string;
  name: string;
  action: () => Promise<unknown>;
  rollback?: () => Promise<void>;
  timeout?: number;
  retries?: number;
  requiresApproval?: boolean;
  dependsOn?: string[];
}

export interface Approval {
  stepId: string;
  requestedAt: Date;
  grantedAt?: Date;
  grantedBy?: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface WorkflowContext {
  workflowId: string;
  initiator: string;
  input: unknown;
  output: unknown;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  currentStep: number;
  startedAt: Date;
  completedAt?: Date;
  errors: Error[];
  approvals: Approval[];
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Workflow engine: steps with retries, timeouts, dependency ordering,
 * human-approval gates, rollback-on-failure, and a full audit trail.
 */
export class WorkflowEngine extends EventEmitter {
  private readonly workflows = new Map<string, WorkflowContext>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    super();
    this.audit = audit;
  }

  startWorkflow(steps: WorkflowStep[], input: unknown, initiator = 'system'): string {
    const workflowId = this.generateId();
    const context: WorkflowContext = {
      workflowId,
      initiator,
      input,
      output: undefined,
      status: 'pending',
      steps,
      currentStep: 0,
      startedAt: new Date(),
      errors: [],
      approvals: [],
    };
    this.workflows.set(workflowId, context);
    metrics.activeWorkflows.inc();
    this.audit.logAction({
      action: 'workflow_started',
      metadata: { workflowId, initiator, stepCount: steps.length },
    });
    setImmediate(() => {
      void this.executeWorkflow(workflowId);
    });
    return workflowId;
  }

  private async executeWorkflow(workflowId: string): Promise<void> {
    const context = this.workflows.get(workflowId);
    if (!context) {
      return;
    }
    context.status = 'running';
    this.emit('workflow:start', { workflowId });

    await tracer.trace(
      `workflow.${workflowId}`,
      async span => {
        tracer.setAttribute(span, 'initiator', context.initiator);
        tracer.setAttribute(span, 'stepCount', String(context.steps.length));

        for (let i = 0; i < context.steps.length; i++) {
          const step = context.steps[i];
          context.currentStep = i;

          if (step.dependsOn && !this.checkDependencies(context, step)) {
            continue;
          }

          if (step.requiresApproval) {
            const approved = await this.waitForApproval(workflowId, step);
            if (!approved) {
              context.status = 'failed';
              this.emit('workflow:rejected', { workflowId, stepId: step.id });
              break;
            }
          }

          try {
            const result = await this.executeStep(step, context);
            context.output = result;
            this.audit.logAction({
              action: 'step_completed',
              metadata: { workflowId, stepId: step.id, stepName: step.name },
            });
            this.emit('step:complete', { workflowId, stepId: step.id, result });
          } catch (error) {
            context.errors.push(error instanceof Error ? error : new Error(String(error)));
            this.audit.logAction({
              action: 'step_failed',
              metadata: {
                workflowId,
                stepId: step.id,
                stepName: step.name,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            this.emit('step:failed', { workflowId, stepId: step.id, error });
            await this.rollbackWorkflow(workflowId);
            break;
          }
        }

        if (
          context.status !== 'failed' &&
          context.status !== 'cancelled' &&
          context.status !== 'rolled_back'
        ) {
          context.status = 'completed';
          context.completedAt = new Date();
          this.emit('workflow:complete', { workflowId, output: context.output });
        }

        const duration = context.completedAt
          ? context.completedAt.getTime() - context.startedAt.getTime()
          : Date.now() - context.startedAt.getTime();
        recordWorkflowMetrics(
          `workflow_${workflowId}`,
          duration,
          context.status === 'completed' ? 'success' : 'failed',
        );
      },
      { workflowId },
    );
  }

  private async executeStep(step: WorkflowStep, _context: WorkflowContext): Promise<unknown> {
    const retries = step.retries ?? 0;
    const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.withTimeout(step.action(), timeout);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          logger.warn(
            {
              stepId: step.id,
              attempt: attempt + 1,
              maxRetries: retries,
              error: lastError.message,
            },
            'Step retry',
          );
          await this.delay(1000 * (attempt + 1));
        }
      }
    }
    throw lastError ?? new Error(`Step ${step.id} failed after ${retries} retries`);
  }

  private async rollbackWorkflow(workflowId: string): Promise<void> {
    const context = this.workflows.get(workflowId);
    if (!context) {
      return;
    }
    logger.warn({ workflowId }, 'Rolling back workflow');
    context.status = 'rolled_back';

    for (let i = context.steps.length - 1; i >= 0; i--) {
      const step = context.steps[i];
      if (step.rollback) {
        try {
          await step.rollback();
          this.audit.logAction({
            action: 'rollback_completed',
            metadata: { workflowId, stepId: step.id, stepName: step.name },
          });
        } catch (error) {
          logger.error(
            {
              workflowId,
              stepId: step.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Rollback failed',
          );
          this.audit.logAction({
            action: 'rollback_failed',
            metadata: {
              workflowId,
              stepId: step.id,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }
    this.emit('workflow:rolled_back', { workflowId });
  }

  private waitForApproval(workflowId: string, step: WorkflowStep): Promise<boolean> {
    const context = this.workflows.get(workflowId);
    if (!context) {
      return Promise.resolve(false);
    }
    context.status = 'waiting_approval';
    const approval: Approval = { stepId: step.id, requestedAt: new Date(), status: 'pending' };
    context.approvals.push(approval);

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.emit('approval:timeout', { workflowId, stepId: step.id });
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);

      this.once(`approval:${workflowId}:${step.id}`, (decision: { approved: boolean }) => {
        clearTimeout(timeout);
        approval.grantedAt = new Date();
        approval.grantedBy = 'user';
        approval.status = decision.approved ? 'approved' : 'rejected';
        resolve(decision.approved);
      });

      // Emit after the listener above is registered so an automated approver
      // reacting synchronously to 'approval:required' is never missed.
      this.emit('approval:required', {
        workflowId,
        stepId: step.id,
        stepName: step.name,
        input: context.input,
      });
    });
  }

  approve(workflowId: string, stepId: string, grantedBy: string): void {
    const context = this.workflows.get(workflowId);
    if (!context) {
      return;
    }
    const approval = context.approvals.find(a => a.stepId === stepId && a.status === 'pending');
    if (approval) {
      approval.grantedAt = new Date();
      approval.grantedBy = grantedBy;
      approval.status = 'approved';
    }
    this.emit(`approval:${workflowId}:${stepId}`, { approved: true });
  }

  reject(workflowId: string, stepId: string, rejectedBy: string): void {
    const context = this.workflows.get(workflowId);
    if (!context) {
      return;
    }
    const approval = context.approvals.find(a => a.stepId === stepId && a.status === 'pending');
    if (approval) {
      approval.grantedAt = new Date();
      approval.grantedBy = rejectedBy;
      approval.status = 'rejected';
    }
    this.emit(`approval:${workflowId}:${stepId}`, { approved: false });
  }

  private checkDependencies(context: WorkflowContext, step: WorkflowStep): boolean {
    if (!step.dependsOn) {
      return true;
    }
    const completedSteps = context.steps.slice(0, context.currentStep).map(s => s.id);
    return step.dependsOn.every(dep => completedSteps.includes(dep));
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateId(): string {
    return `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  getStatus(workflowId: string): WorkflowContext | null {
    return this.workflows.get(workflowId) ?? null;
  }

  listWorkflows(): Array<{ id: string; status: WorkflowStatus; startedAt: Date }> {
    return [...this.workflows.entries()].map(([id, ctx]) => ({
      id,
      status: ctx.status,
      startedAt: ctx.startedAt,
    }));
  }
}

export const workflowEngine = new WorkflowEngine();
