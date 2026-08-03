import type { Octokit } from '@octokit/rest';

import type { BreakingChange } from '../diff/engine';
import { logger } from '../logger';

export interface DedupeResult {
  exists: boolean;
  prNumber?: number;
  prUrl?: string;
}

const STALE_DAYS = 7;

/**
 * Idempotency guard for PR creation: skips when a PR from the same branch is
 * already open, and closes Mantior PRs that have been sitting unmerged too
 * long (they get re-created fresh on the next scan once they go stale).
 */
export class PRDeduplicator {
  constructor(private readonly octokit: Octokit) {}

  async findExistingPR(
    owner: string,
    repo: string,
    branchName: string,
    changes: BreakingChange[],
  ): Promise<DedupeResult> {
    try {
      const { data: pulls } = await this.octokit.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${branchName}`,
      });
      const first = pulls[0];
      if (first) {
        return { exists: true, prNumber: first.number, prUrl: first.html_url };
      }
    } catch (error) {
      logger.warn({ owner, repo, branchName, error }, 'Failed to list existing PRs by head');
    }

    // Fallback: search by title fragment for this change set.
    const searchTerm = changes
      .map(change => change.message)
      .join(' ')
      .slice(0, 50);
    if (searchTerm.length === 0) {
      return { exists: false };
    }
    try {
      const { data: searchResults } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:open ${searchTerm}`,
        per_page: 5,
      });
      for (const item of searchResults.items) {
        if (item.title.includes('Mantior')) {
          return { exists: true, prNumber: item.number, prUrl: item.html_url };
        }
      }
    } catch (error) {
      logger.warn({ owner, repo, error }, 'Failed to search for existing Mantior PRs');
    }

    return { exists: false };
  }

  async closeStalePRs(owner: string, repo: string, branchName: string): Promise<void> {
    try {
      const { data: pulls } = await this.octokit.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${branchName}`,
      });
      const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
      for (const pull of pulls) {
        if (new Date(pull.created_at) < cutoff) {
          await this.octokit.pulls.update({
            owner,
            repo,
            pull_number: pull.number,
            state: 'closed',
          });
          logger.info({ owner, repo, prNumber: pull.number }, 'Closed stale PR');
        }
      }
    } catch (error) {
      logger.warn({ owner, repo, branchName, error }, 'Failed to close stale PRs');
    }
  }
}
