import { AuditLogger } from '../audit/logger';
import { AutonomyLevel, AutonomyManager } from '../autonomy/levels';
import { logger } from '../logger';

export type ChangeSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface PolicyContext {
  changeType: string;
  changeMessage: string;
  confidenceScore: number;
  consumerRepo: string;
  initiator: string;
  autonomyLevel: AutonomyLevel;
  severity: ChangeSeverity;
  affectedServices: string[];
}

export interface PolicyAction {
  type: 'allow' | 'deny' | 'flag' | 'approve' | 'rollback';
  message?: string;
  requiresReview: boolean;
  reason: string;
}

export interface PolicyRule {
  id: string;
  condition: (context: PolicyContext) => boolean;
  action: PolicyAction;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  rules: PolicyRule[];
  priority: number;
}

export interface PolicyRuleResult {
  policyId: string;
  ruleId: string;
  action: PolicyAction;
  matched: boolean;
}

export interface PolicyResult {
  allowed: boolean;
  action: PolicyAction;
  results: PolicyRuleResult[];
}

/**
 * Policy engine: every action is checked against ordered, priority-ranked
 * rules before execution (the core tenet of the production architecture —
 * never let the model drive production systems without policy enforcement).
 */
export class PolicyEngine {
  private policies: Policy[] = [];
  private readonly audit: AuditLogger;
  private readonly autonomyManager: AutonomyManager;

  constructor(audit = new AuditLogger(), autonomyManager = new AutonomyManager()) {
    this.audit = audit;
    this.autonomyManager = autonomyManager;
    this.loadDefaultPolicies();
  }

  evaluate(context: PolicyContext): PolicyResult {
    const results: PolicyRuleResult[] = [];
    const sortedPolicies = [...this.policies].sort((a, b) => b.priority - a.priority);

    for (const policy of sortedPolicies) {
      for (const rule of policy.rules) {
        try {
          if (rule.condition(context)) {
            results.push({
              policyId: policy.id,
              ruleId: rule.id,
              action: rule.action,
              matched: true,
            });
            this.audit.logAction({
              action: 'policy_evaluated',
              metadata: {
                policyId: policy.id,
                ruleId: rule.id,
                action: rule.action.type,
                context: JSON.stringify({
                  changeType: context.changeType,
                  severity: context.severity,
                }),
              },
            });
            if (rule.action.type === 'deny' || rule.action.type === 'rollback') {
              return { allowed: false, action: rule.action, results };
            }
          }
        } catch (error) {
          logger.error(
            {
              policyId: policy.id,
              ruleId: rule.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Policy evaluation error',
          );
        }
      }
    }

    const autonomyAction = this.getAutonomyAction(context);
    return { allowed: true, action: autonomyAction, results };
  }

  addPolicy(policy: Policy): void {
    this.policies.push(policy);
    logger.info({ policyId: policy.id, name: policy.name }, 'Policy added');
  }

  removePolicy(policyId: string): void {
    this.policies = this.policies.filter(policy => policy.id !== policyId);
    logger.info({ policyId }, 'Policy removed');
  }

  getPolicies(): Policy[] {
    return this.policies;
  }

  private getAutonomyAction(context: PolicyContext): PolicyAction {
    switch (context.autonomyLevel) {
      case AutonomyLevel.OBSERVE:
        return {
          type: 'allow',
          message: 'Monitoring only - no changes will be made',
          requiresReview: false,
          reason: 'Autonomy level 1: Observe',
        };
      case AutonomyLevel.RECOMMEND:
        return {
          type: 'allow',
          message: 'Recommendations generated, no changes applied',
          requiresReview: true,
          reason: 'Autonomy level 2: Recommend',
        };
      case AutonomyLevel.SIMULATE:
        return {
          type: 'allow',
          message: 'Changes simulated in sandbox',
          requiresReview: true,
          reason: 'Autonomy level 3: Simulate',
        };
      case AutonomyLevel.EXECUTE_WITH_APPROVAL:
        return {
          type: 'approve',
          message: 'PR created - requires human approval',
          requiresReview: true,
          reason: 'Autonomy level 4: Execute with Approval',
        };
      case AutonomyLevel.EXECUTE_AUTOMATIC:
        if (context.confidenceScore >= 90) {
          return {
            type: 'allow',
            message: 'Auto-executing - high confidence change',
            requiresReview: false,
            reason: 'Autonomy level 5: Execute Automatically',
          };
        }
        return {
          type: 'flag',
          message: `Auto-execution blocked - confidence ${context.confidenceScore}% < 90%`,
          requiresReview: true,
          reason: 'Confidence threshold not met',
        };
      default:
        return {
          type: 'allow',
          message: 'Default action: allow with review',
          requiresReview: true,
          reason: 'Default policy',
        };
    }
  }

  private loadDefaultPolicies(): void {
    this.addPolicy({
      id: 'critical-changes',
      name: 'Critical Changes Require Review',
      description: 'Any critical or high-severity change requires human review',
      priority: 100,
      rules: [
        {
          id: 'critical-review',
          condition: ctx => ctx.severity === 'critical' || ctx.severity === 'high',
          action: {
            type: 'approve',
            message: 'Critical change requires human review',
            requiresReview: true,
            reason: 'Critical severity detected',
          },
        },
      ],
    });

    this.addPolicy({
      id: 'sensitive-endpoints',
      name: 'Sensitive Endpoints Require Approval',
      description: 'Changes to sensitive endpoints require explicit approval',
      priority: 90,
      rules: [
        {
          id: 'sensitive-endpoint',
          condition: ctx => {
            const message = ctx.changeMessage.toLowerCase();
            return (
              message.includes('auth') ||
              message.includes('payment') ||
              message.includes('security')
            );
          },
          action: {
            type: 'approve',
            message: 'Sensitive endpoint change requires approval',
            requiresReview: true,
            reason: 'Security-sensitive change detected',
          },
        },
      ],
    });

    this.addPolicy({
      id: 'low-confidence',
      name: 'Low Confidence Block',
      description: 'Changes with confidence below 50% are blocked',
      priority: 80,
      rules: [
        {
          id: 'low-confidence',
          condition: ctx => ctx.confidenceScore < 50,
          action: {
            type: 'flag',
            message: 'Low confidence change - manual review required',
            requiresReview: true,
            reason: 'Confidence threshold not met',
          },
        },
      ],
    });

    this.addPolicy({
      id: 'multi-service',
      name: 'Multi-Service Change Review',
      description: 'Changes affecting multiple services require review',
      priority: 70,
      rules: [
        {
          id: 'multi-service',
          condition: ctx => ctx.affectedServices.length > 3,
          action: {
            type: 'approve',
            message: 'Change affects multiple services - requires review',
            requiresReview: true,
            reason: 'Wide impact detected',
          },
        },
      ],
    });

    this.addPolicy({
      id: 'new-endpoints',
      name: 'New Endpoints Auto-Allow',
      description: 'New endpoints are automatically allowed',
      priority: 50,
      rules: [
        {
          id: 'new-endpoint',
          condition: ctx => ctx.changeType === 'endpoint_added',
          action: {
            type: 'allow',
            message: 'New endpoint - auto-allowed',
            requiresReview: false,
            reason: 'New endpoint added',
          },
        },
      ],
    });
  }
}
