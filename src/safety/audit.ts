import { AuditLogger } from '../audit/logger';

/**
 * Safety audit facade: re-exports the immutable audit trail with
 * safety-specific event types (violations, approvals, rollbacks).
 */
export class SafetyAuditLogger extends AuditLogger {
  /**
   * Log a safety-critical event.
   */
  logSafetyEvent(
    action: string,
    context: {
      operation: string;
      userId: string;
      resource: string;
      actionType: string;
    },
    details: {
      before?: unknown;
      after?: unknown;
      reason?: string;
      approvedBy?: string;
      rollbackId?: string;
    },
  ): void {
    this.logAction({
      action: `safety.${action}`,
      userId: context.userId,
      metadata: {
        operation: context.operation,
        resource: context.resource,
        actionType: context.actionType,
        ...details,
      },
      before: details.before,
      after: details.after,
    });
  }

  /**
   * Log a safety violation.
   */
  logViolation(userId: string, action: string, resource: string, reason: string): void {
    this.logAction({
      action: 'safety.violation',
      userId,
      metadata: {
        action,
        resource,
        reason,
      },
    });
  }

  /**
   * Log an approval event.
   */
  logApproval(
    requestId: string,
    userId: string,
    status: 'approved' | 'rejected',
    comment?: string,
  ): void {
    this.logAction({
      action: `safety.approval.${status}`,
      userId,
      metadata: {
        requestId,
        comment,
      },
    });
  }

  /**
   * Log a rollback event.
   */
  logRollback(
    planId: string,
    userId: string,
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>,
  ): void {
    this.logAction({
      action: `safety.rollback.${status}`,
      userId,
      metadata: {
        planId,
        ...details,
      },
    });
  }
}

export const safetyAudit = new SafetyAuditLogger();
