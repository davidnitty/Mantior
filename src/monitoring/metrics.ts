import client from 'prom-client';

import { logger } from '../logger';

const register = new client.Registry();
// Jest sets NODE_ENV=test; skip the scrape interval there so it can't keep
// test workers alive. Production gets default process metrics collection.
if (process.env.NODE_ENV !== 'test') {
  client.collectDefaultMetrics({ register });
}

// ──────────────────────────────────────────────
// APPLICATION METRICS
// ──────────────────────────────────────────────

export const metrics = {
  apiCalls: new client.Counter({
    name: 'mantior_api_calls_total',
    help: 'Total API calls made by Mantior',
    labelNames: ['connector', 'method', 'status'],
    registers: [register],
  }),

  apiCallDuration: new client.Histogram({
    name: 'mantior_api_call_duration_seconds',
    help: 'Duration of API calls',
    labelNames: ['connector', 'method'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
  }),

  agentActions: new client.Counter({
    name: 'mantior_agent_actions_total',
    help: 'Total agent actions taken',
    labelNames: ['action', 'level', 'outcome'],
    registers: [register],
  }),

  agentConfidence: new client.Histogram({
    name: 'mantior_agent_confidence',
    help: 'Confidence scores of agent decisions',
    buckets: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1],
    registers: [register],
  }),

  activeWorkflows: new client.Gauge({
    name: 'mantior_active_workflows',
    help: 'Number of currently active workflows',
    registers: [register],
  }),

  workflowDuration: new client.Histogram({
    name: 'mantior_workflow_duration_seconds',
    help: 'Duration of workflows',
    buckets: [5, 10, 30, 60, 120, 300, 600],
    registers: [register],
  }),

  errors: new client.Counter({
    name: 'mantior_errors_total',
    help: 'Total errors by type',
    labelNames: ['module', 'type'],
    registers: [register],
  }),

  autonomyLevel: new client.Gauge({
    name: 'mantior_autonomy_level',
    help: 'Current autonomy level (1-5)',
    registers: [register],
  }),

  manualInterventions: new client.Counter({
    name: 'mantior_manual_interventions_total',
    help: 'Total manual interventions required',
    labelNames: ['reason'],
    registers: [register],
  }),
};

export { register };

/** Record metrics from a workflow execution. */
export function recordWorkflowMetrics(
  workflowName: string,
  duration: number,
  status: 'success' | 'failed' | 'partial',
): void {
  metrics.activeWorkflows.dec();
  metrics.workflowDuration.observe(duration / 1000);
  logger.debug({ workflowName, duration, status }, 'Workflow metrics recorded');
}
