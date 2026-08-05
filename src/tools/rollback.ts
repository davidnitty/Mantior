import { Octokit } from '@octokit/rest';

import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';
import { tracer } from '../monitoring/traces';

export interface RollbackResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  rollbackId: string;
}

export interface RollbackCheck {
  should: boolean;
  reason?: string;
}

/**
 * Rollback tool: reverts a merged Mantior PR by creating a rollback branch +
 * revert commit and opening a "⚡ [Mantior] Rollback PR". Every step is audited.
 */
export class RollbackTool {
  private readonly octokit: Octokit;
  private readonly audit: AuditLogger;

  constructor(githubToken: string, audit = new AuditLogger()) {
    this.octokit = new Octokit({ auth: githubToken });
    this.audit = audit;
  }

  rollbackPR(
    owner: string,
    repo: string,
    prNumber: number,
    reason: string,
  ): Promise<RollbackResult> {
    return tracer.trace(
      'rollback.pr',
      async span => {
        const rollbackId = `rb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        logger.warn({ owner, repo, prNumber, reason, rollbackId }, 'Initiating rollback');
        tracer.setAttribute(span, 'rollbackId', rollbackId);

        try {
          const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });

          const branchName = `mantior/rollback-${prNumber}-${Date.now()}`;
          await this.octokit.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${branchName}`,
            sha: pr.base.sha,
          });

          const { data: mergeCommit } = await this.octokit.repos.getCommit({
            owner,
            repo,
            ref: pr.merge_commit_sha ?? pr.head.sha,
          });

          const revertMessage = `Revert: ${pr.title}\n\nReason: ${reason}\n\nRollback ID: ${rollbackId}`;
          const { data: revertCommit } = await this.octokit.git.createCommit({
            owner,
            repo,
            message: revertMessage,
            tree: mergeCommit.sha,
            parents: [mergeCommit.parents[0]?.sha ?? pr.base.sha],
          });

          await this.octokit.git.updateRef({
            owner,
            repo,
            ref: `heads/${branchName}`,
            sha: revertCommit.sha,
            force: true,
          });

          const { data: rollbackPR } = await this.octokit.pulls.create({
            owner,
            repo,
            title: `⚡ [Mantior] Rollback PR #${prNumber}`,
            body: `## ⚡ Automatic Rollback

Mantior detected issues with PR #${prNumber} and automatically created this rollback.

**Reason:** ${reason}
**Rollback ID:** ${rollbackId}

**Next Steps:**
1. Review the rollback changes
2. Verify the issue is resolved
3. Merge this PR to restore the previous state

---
*This rollback was generated automatically by Mantior.*`,
            head: branchName,
            base: pr.base.ref,
          });

          this.audit.logAction({
            action: 'rollback_pr_created',
            metadata: {
              rollbackId,
              originalPR: prNumber,
              newPR: rollbackPR.number,
              owner,
              repo,
              reason,
            },
          });
          logger.info(
            { rollbackId, originalPR: prNumber, rollbackPR: rollbackPR.html_url },
            'Rollback PR created',
          );
          return {
            success: true,
            prUrl: rollbackPR.html_url,
            prNumber: rollbackPR.number,
            rollbackId,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ rollbackId, originalPR: prNumber, error: message }, 'Rollback failed');
          this.audit.logAction({
            action: 'rollback_failed',
            metadata: { rollbackId, originalPR: prNumber, error: message },
          });
          return { success: false, error: message, rollbackId };
        }
      },
      { owner, repo, prNumber: String(prNumber) },
    );
  }

  async shouldRollback(owner: string, repo: string, prNumber: number): Promise<RollbackCheck> {
    try {
      const { data: checks } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: `pull/${prNumber}/head`,
      });
      const failedChecks = checks.check_runs.filter(
        run => run.status === 'completed' && run.conclusion === 'failure',
      );
      if (failedChecks.length > 0) {
        return { should: true, reason: `${failedChecks.length} CI checks failed` };
      }
      return { should: false };
    } catch (error) {
      logger.error(
        { owner, repo, prNumber, error: error instanceof Error ? error.message : String(error) },
        'Failed to check rollback status',
      );
      return { should: false, reason: 'Error checking rollback status' };
    }
  }
}
