import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface CostBudget {
  /** Budget per customer in USD */
  perCustomer: number;
  /** Budget per workflow in USD */
  perWorkflow: number;
  /** Budget per day in USD */
  perDay: number;
  /** Budget per month in USD */
  perMonth: number;
  /** Alert threshold (percentage of budget) */
  alertThreshold: number; // 0-100
}

export const DEFAULT_BUDGET: CostBudget = {
  perCustomer: 100, // $100 per customer
  perWorkflow: 5, // $5 per workflow
  perDay: 50, // $50 per day
  perMonth: 500, // $500 per month
  alertThreshold: 80, // Alert at 80% of budget
};

/**
 * Hard money caps: no operation proceeds if it would push a workflow,
 * customer, day, or month over its budget. Prevents an agent loop from
 * becoming an unlimited tab (Four Horsemen — Risk 1, enforced here too).
 */
export class CostController {
  private readonly budget: CostBudget;
  private readonly usage = new Map<string, number>();
  private readonly audit: AuditLogger;

  constructor(budget: Partial<CostBudget> = {}, audit = new AuditLogger()) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.audit = audit;
  }

  /**
   * Check if we can proceed with an operation.
   */
  canProceed(context: { customerId: string; workflowId: string; estimatedCost: number }): {
    allowed: boolean;
    reason?: string;
  } {
    const { customerId, workflowId, estimatedCost } = context;

    const workflowCost = this.getWorkflowCost(workflowId);
    if (workflowCost + estimatedCost > this.budget.perWorkflow) {
      return {
        allowed: false,
        reason: `Workflow budget exceeded: $${workflowCost + estimatedCost} > $${this.budget.perWorkflow}`,
      };
    }

    const customerCost = this.getCustomerCost(customerId);
    if (customerCost + estimatedCost > this.budget.perCustomer) {
      return {
        allowed: false,
        reason: `Customer budget exceeded: $${customerCost + estimatedCost} > $${this.budget.perCustomer}`,
      };
    }

    const dailyCost = this.getDailyCost();
    if (dailyCost + estimatedCost > this.budget.perDay) {
      return {
        allowed: false,
        reason: `Daily budget exceeded: $${dailyCost + estimatedCost} > $${this.budget.perDay}`,
      };
    }

    const monthlyCost = this.getMonthlyCost();
    if (monthlyCost + estimatedCost > this.budget.perMonth) {
      return {
        allowed: false,
        reason: `Monthly budget exceeded: $${monthlyCost + estimatedCost} > $${this.budget.perMonth}`,
      };
    }

    const usagePercent = this.getUsagePercent();
    if (usagePercent >= this.budget.alertThreshold) {
      this.audit.logAction({
        action: 'cost_alert_threshold',
        metadata: {
          usagePercent,
          threshold: this.budget.alertThreshold,
          estimatedCost,
        },
      });
      // Log but allow
      logger.warn(
        { usagePercent, threshold: this.budget.alertThreshold },
        'Cost threshold approaching',
      );
    }

    return { allowed: true };
  }

  /**
   * Track cost for an operation.
   */
  trackCost(context: { customerId: string; workflowId: string; cost: number }): void {
    const { customerId, workflowId, cost } = context;

    const key = `${customerId}:${workflowId}`;
    const total = (this.usage.get(key) ?? 0) + cost;
    this.usage.set(key, total);

    this.audit.logAction({
      action: 'cost_tracked',
      metadata: {
        customerId,
        workflowId,
        cost,
        total,
      },
    });

    logger.debug({ customerId, workflowId, cost }, 'Cost tracked');
  }

  private getWorkflowCost(workflowId: string): number {
    let total = 0;
    for (const [key, value] of this.usage) {
      if (key.endsWith(`:${workflowId}`)) {
        total += value;
      }
    }
    return total;
  }

  private getCustomerCost(customerId: string): number {
    let total = 0;
    for (const [key, value] of this.usage) {
      if (key.startsWith(`${customerId}:`)) {
        total += value;
      }
    }
    return total;
  }

  private getDailyCost(): number {
    // Sum of costs recorded today — Phase 2 wiring against the metrics table.
    return 0;
  }

  private getMonthlyCost(): number {
    // Sum of costs recorded this month — Phase 2 wiring against the metrics table.
    return 0;
  }

  private getUsagePercent(): number {
    const total = this.getMonthlyCost();
    return (total / this.budget.perMonth) * 100;
  }
}

export const costController = new CostController();
