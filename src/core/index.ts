// ──────────────────────────────────────────────
// MANTIOR CORE — PUBLIC ARCHITECTURE EXPORTS
// ──────────────────────────────────────────────
// The enterprise production surface. Layer completeness:
// built = implemented + unit tested; the remaining modules from the
// architecture spec (webhooks/database/cloud connectors, uptime/error
// monitors, docs/incidents knowledge, codegen/ticketing/deployment tools,
// permission/action/approval policy files, audit search/export facades,
// dashboard widgets) land in the Phase-2 batches.

// API CONNECTORS
export * from '../connectors/base';
export * from '../connectors/rest';
export * from '../connectors/graphql';

// MONITORING
export * from '../monitoring/metrics';
export * from '../monitoring/traces';

// AGENT ORCHESTRATION
export * from '../orchestration/workflow';

// KNOWLEDGE LAYER
export * from '../knowledge/specs';
export * from '../knowledge/runbooks';

// TOOL LAYER
export * from '../tools/testing';
export * from '../tools/rollback';

// POLICY ENGINE
export * from '../policy/engine';

// AUDIT SYSTEM
export * from '../audit/logger';

// SAFETY LAYER
export * from '../safety/dry-run';
export * from '../safety/permissions';
export * from '../safety/validation';
export * from '../safety/rate-limit';
export * from '../safety/timeouts';
export * from '../safety/idempotency';
export * from '../safety/rollback';
export {
  ApprovalContext,
  ApprovalManager,
  ApprovalRequest,
  ApprovalRule,
  approvalManager,
} from '../safety/approvals';
export type { Approval as SafetyApproval } from '../safety/approvals';
export * from '../safety/audit';
export * from '../safety/metrics';
export * from '../safety/cost-control';

// DASHBOARD
export { router as dashboardRouter } from '../dashboard/api';
