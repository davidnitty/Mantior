import { Counter, Registry } from 'prom-client';

/**
 * Shared prom-client registry + the counters the rest of the codebase
 * references (dropped contract: prsOpened, errorsTotal, fixAttempts).
 */
export const register = new Registry();

export const prsOpened = new Counter({
  name: 'mantior_prs_opened_total',
  help: 'Number of PRs opened by Mantior',
  labelNames: ['repo', 'status'],
  registers: [register],
});

export const errorsTotal = new Counter({
  name: 'mantior_errors_total',
  help: 'Number of errors encountered',
  labelNames: ['module'],
  registers: [register],
});

export const fixAttempts = new Counter({
  name: 'mantior_fix_attempts_total',
  help: 'Fix attempts by result (deterministic, llm_success, llm_low_confidence, llm_failed, manual_required, failed)',
  labelNames: ['result'],
  registers: [register],
});

export const scansTotal = new Counter({
  name: 'mantior_scans_total',
  help: 'Number of scans executed',
  registers: [register],
});

/** Prometheus text exposition of all registered metrics. */
export async function metricsContent(): Promise<string> {
  const content = await register.metrics();
  return content;
}
