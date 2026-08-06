import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';

export interface ApprovalRule {
  id: string;
  name: string;
  description: string;
  condition: (context: ApprovalContext) => boolean;
  requiredApprovers: number;
  approverGroups: string[];
  timeoutMs: number;
}

export interface ApprovalContext {
  action: string;
  resource: string;
  environment: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  user: string;
  changes: unknown[];
  estimatedImpact: string;
  requiredApprovals: number;
}

export interface ApprovalRequest {
  id: string;
  ruleId: string;
  context: ApprovalContext;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: Date;
  respondedAt?: Date;
  approvals: Approval[];
  rejections: Approval[];
}

export interface Approval {
  id: string;
  approver: string;
  timestamp: Date;
  comment?: string;
}

/**
 * Human-in-the-loop gates: actions matching an approval rule cannot proceed
 * until the required number of authorized approvers sign off. This is the
 * last line between "the AI plans" and "the system acts".
 */
export class ApprovalManager {
  private readonly rules: ApprovalRule[] = [];
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
    this.loadDefaultRules();
  }

  /**
   * Check if an action requires approval.
   */
  requiresApproval(context: ApprovalContext): { requires: boolean; rule?: ApprovalRule } {
    for (const rule of this.rules) {
      if (rule.condition(context)) {
        return { requires: true, rule };
      }
    }
    return { requires: false };
  }

  /**
   * Request approval for an action.
   */
  requestApproval(context: ApprovalContext): string {
    const check = this.requiresApproval(context);
    if (!check.requires || !check.rule) {
      throw new Error('This action does not require approval');
    }

    const rule = check.rule;
    const requestId = `apr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const request: ApprovalRequest = {
      id: requestId,
      ruleId: rule.id,
      context,
      status: 'pending',
      requestedAt: new Date(),
      approvals: [],
      rejections: [],
    };

    this.requests.set(requestId, request);

    this.audit.logAction({
      action: 'approval_requested',
      metadata: {
        requestId,
        ruleId: rule.id,
        action: context.action,
        resource: context.resource,
        requiredApprovers: rule.requiredApprovers,
      },
    });

    // Notify approvers (Phase 2: notification channel dispatch).
    return requestId;
  }

  /**
   * Approve a request (may require multiple approvers).
   */
  approve(requestId: string, approver: string, comment?: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Request already ${request.status}`);
    }

    const rule = this.rules.find(r => r.id === request.ruleId);
    if (rule && !rule.approverGroups.includes(approver)) {
      throw new Error(`User ${approver} is not authorized to approve this request`);
    }

    request.approvals.push({
      id: `app_${Date.now()}_${request.approvals.length}`,
      approver,
      timestamp: new Date(),
      comment,
    });

    if (rule && request.approvals.length >= rule.requiredApprovers) {
      request.status = 'approved';
      request.respondedAt = new Date();
    }

    this.audit.logAction({
      action: 'approval_granted',
      userId: approver,
      metadata: {
        requestId,
        totalApprovals: request.approvals.length,
        status: request.status,
      },
    });

    this.requests.set(requestId, request);
  }

  /**
   * Reject a request.
   */
  reject(requestId: string, approver: string, reason: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Request already ${request.status}`);
    }

    request.status = 'rejected';
    request.respondedAt = new Date();
    request.rejections.push({
      id: `rej_${Date.now()}`,
      approver,
      timestamp: new Date(),
      comment: reason,
    });

    this.audit.logAction({
      action: 'approval_rejected',
      userId: approver,
      metadata: {
        requestId,
        reason,
      },
    });

    this.requests.set(requestId, request);
  }

  /**
   * Get pending approvals.
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter(r => r.status === 'pending');
  }

  /**
   * Get approval history.
   */
  getHistory(limit = 100): ApprovalRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.status !== 'pending')
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
      .slice(0, limit);
  }

  /**
   * Add a custom approval rule.
   */
  addRule(rule: ApprovalRule): void {
    this.rules.push(rule);
    logger.info({ ruleId: rule.id, name: rule.name }, 'Approval rule added');
  }

  private loadDefaultRules(): void {
    this.rules.push({
      id: 'critical-changes',
      name: 'Critical Changes',
      description: 'Critical changes require 2 approvals',
      condition: ctx => ctx.severity === 'critical',
      requiredApprovers: 2,
      approverGroups: ['admin', 'lead', 'manager'],
      timeoutMs: 3_600_000, // 1 hour
    });

    this.rules.push({
      id: 'database-schema',
      name: 'Database Schema Changes',
      description: 'Database schema changes require 1 approval',
      condition: ctx => ctx.resource === 'database' && ctx.action === 'schema_change',
      requiredApprovers: 1,
      approverGroups: ['dba', 'admin'],
      timeoutMs: 1_800_000, // 30 minutes
    });

    this.rules.push({
      id: 'production-changes',
      name: 'Production Changes',
      description: 'Production environment changes require 1 approval',
      condition: ctx => ctx.environment === 'production',
      requiredApprovers: 1,
      approverGroups: ['admin', 'manager'],
      timeoutMs: 1_800_000, // 30 minutes
    });
  }
}

export const approvalManager = new ApprovalManager();
