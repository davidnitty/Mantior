import type { Octokit } from '@octokit/rest';

import { logger } from '../logger';

const POLL_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 60; // 10 minutes

/**
 * Waits for CI checks on a Mantior PR head ref to complete.
 * Used post-PR by the orchestrator when CI-waiting is enabled.
 */
export class PRMonitor {
  constructor(private readonly octokit: Octokit) {}

  async waitForCI(owner: string, repo: string, prNumber: number): Promise<'success' | 'failure'> {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      try {
        const { data: checks } = await this.octokit.checks.listForRef({
          owner,
          repo,
          ref: `pull/${prNumber}/head`,
        });

        if (
          checks.check_runs.length > 0 &&
          checks.check_runs.every(run => run.status === 'completed')
        ) {
          const allPassed = checks.check_runs.every(run => run.conclusion === 'success');
          logger.info({ owner, repo, prNumber, allPassed }, 'CI checks completed');
          return allPassed ? 'success' : 'failure';
        }
      } catch (error) {
        logger.warn({ owner, repo, prNumber, attempts, error }, 'CI check poll failed');
      }

      await new Promise(resolvePromise => setTimeout(resolvePromise, POLL_INTERVAL_MS));
      attempts++;
    }
    logger.warn({ owner, repo, prNumber }, 'Timed out waiting for CI');
    return 'failure';
  }
}
