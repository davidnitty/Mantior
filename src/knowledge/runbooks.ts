import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface RunbookStep {
  id: string;
  order: number;
  description: string;
  action: 'manual' | 'automated';
  command?: string;
  expectedResult?: string;
}

export interface Runbook {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: RunbookStep[];
  tags: string[];
}

export interface RunbookStepResult {
  stepId: string;
  success: boolean;
  output?: string;
  error?: string;
  manual?: boolean;
}

export interface RunbookResult {
  runbookId: string;
  startedAt: Date;
  completedAt: Date;
  success: boolean;
  results: RunbookStepResult[];
}

/**
 * Runbook repository with default incident-response procedures. Automated
 * steps are placeholders wired to the orchestrator in a later phase; manual
 * steps are surfaced as checklist items.
 */
export class RunbookRepository {
  private readonly runbooks = new Map<string, Runbook>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
    this.loadDefaultRunbooks();
  }

  getRunbook(trigger: string): Runbook | null {
    for (const runbook of this.runbooks.values()) {
      if (runbook.trigger === trigger) {
        return runbook;
      }
    }
    return null;
  }

  executeRunbook(runbookId: string, context: Record<string, unknown>): Promise<RunbookResult> {
    const runbook = this.runbooks.get(runbookId);
    if (!runbook) {
      throw new Error(`Runbook not found: ${runbookId}`);
    }
    logger.info({ runbookId, context }, 'Executing runbook');
    this.audit.logAction({
      action: 'runbook_started',
      metadata: { runbookId, context: JSON.stringify(context) },
    });

    const results: RunbookStepResult[] = [];
    for (const step of [...runbook.steps].sort((a, b) => a.order - b.order)) {
      if (step.action === 'automated') {
        results.push({ stepId: step.id, success: true, output: 'Automated step executed' });
      } else {
        results.push({
          stepId: step.id,
          success: true,
          output: `Manual step: ${step.description}`,
          manual: true,
        });
      }
    }
    return Promise.resolve({
      runbookId,
      startedAt: new Date(),
      completedAt: new Date(),
      success: results.every(r => r.success),
      results,
    });
  }

  private loadDefaultRunbooks(): void {
    this.runbooks.set('api-breaking-change', {
      id: 'api-breaking-change',
      name: 'API Breaking Change Response',
      description: 'Response procedure for detected breaking API changes',
      trigger: 'breaking_change_detected',
      tags: ['api', 'breaking-change', 'response'],
      steps: [
        {
          id: 'step1',
          order: 1,
          description: 'Review the breaking change impact',
          action: 'manual',
        },
        {
          id: 'step2',
          order: 2,
          description: 'Run automated fixes if confidence ≥ 70%',
          action: 'automated',
        },
        {
          id: 'step3',
          order: 3,
          description: 'Open PR with fixes for review',
          action: 'automated',
        },
        { id: 'step4', order: 4, description: 'Notify affected teams', action: 'manual' },
      ],
    });
    this.runbooks.set('high-error-rate', {
      id: 'high-error-rate',
      name: 'High Error Rate Response',
      description: 'Response procedure for elevated error rates',
      trigger: 'error_rate_elevated',
      tags: ['errors', 'response', 'critical'],
      steps: [
        { id: 'step1', order: 1, description: 'Identify the error pattern', action: 'automated' },
        { id: 'step2', order: 2, description: 'Check for recent API changes', action: 'automated' },
        { id: 'step3', order: 3, description: 'Rollback if necessary', action: 'manual' },
      ],
    });
  }
}
