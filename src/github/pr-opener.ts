import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';

import type { MantiorConfig } from '../config/loader';
import type { BreakingChange } from '../diff/engine';
import { logger } from '../logger';
import { prsOpened } from '../metrics';

export enum PROpeningStrategy {
  DIRECT = 'direct',
  FORK = 'fork',
}

export interface PROptions {
  strategy?: PROpeningStrategy;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  labels?: string[];
  reviewers?: string[];
  draft?: boolean;
}

export interface PROpeningResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
  strategy: PROpeningStrategy;
  repo: string;
  owner: string;
}

const BRANCH_PREFIX = 'mantior/auto-fix';

/**
 * Direct-branch-first, fork-fallback PR opener. Idempotent callers pair this
 * with PRDeduplicator.openPrIfMissing to avoid duplicate PRs.
 */
export class PROpener {
  private readonly octokit: Octokit;
  private readonly token: string;

  constructor(private readonly config: MantiorConfig) {
    this.token = config.security.github_token ?? process.env.GITHUB_TOKEN ?? '';
    this.octokit = new Octokit({ auth: this.token, userAgent: 'Mantior/1.0' });
  }

  get enabled(): boolean {
    return this.token !== '';
  }

  async createPR(
    repoPath: string,
    repoUrl: string,
    baseBranch: string,
    fixedFiles: Record<string, string>,
    changes: BreakingChange[],
    options: PROptions = {},
  ): Promise<PROpeningResult> {
    const startTime = Date.now();
    logger.info({ repoUrl, baseBranch, changeCount: changes.length }, 'Creating PR');

    const repoInfo = parseRepoUrl(repoUrl);
    if (!repoInfo) {
      throw new Error(`Invalid repo URL: ${repoUrl}`);
    }
    const { owner, repo } = repoInfo;
    if (!this.enabled) {
      throw new Error(`Cannot open PR: no GitHub token configured for ${owner}/${repo}`);
    }

    const strategy = await this.determineStrategy(owner, repo, options.strategy);
    const branchName = this.generateBranchName();
    const targetOwner =
      strategy === PROpeningStrategy.FORK ? await this.getForkOwner(owner, repo) : owner;

    const git = simpleGit(repoPath);
    await git.checkoutLocalBranch(branchName);

    for (const [filePath, content] of Object.entries(fixedFiles)) {
      const absolutePath = join(repoPath, filePath);
      const dir = dirname(absolutePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(absolutePath, content, 'utf8');
      await git.add(filePath);
    }

    const commitMessage = options.commitMessage ?? this.generateCommitMessage(changes);
    await git.commit(commitMessage);

    const remote = strategy === PROpeningStrategy.FORK ? 'fork' : 'origin';
    const targetRepoUrl = `https://x-access-token:${this.token}@github.com/${targetOwner}/${repo}.git`;
    if (strategy === PROpeningStrategy.FORK) {
      await git.addRemote(remote, targetRepoUrl);
    }
    await git.push(remote, branchName, ['--set-upstream']);

    const pr = await this.openPullRequest(
      owner,
      repo,
      targetOwner,
      branchName,
      baseBranch,
      changes,
      options,
    );

    if (options.labels && options.labels.length > 0) {
      await this.addLabels(owner, repo, pr.data.number, options.labels);
    }
    if (options.reviewers && options.reviewers.length > 0) {
      await this.requestReviewers(owner, repo, pr.data.number, options.reviewers);
    }

    prsOpened.inc({ repo, status: 'success' });
    logger.info(
      {
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        duration: (Date.now() - startTime) / 1000,
        strategy,
      },
      'PR opened successfully',
    );

    return {
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
      branchName,
      strategy,
      repo,
      owner,
    };
  }

  // ──────────────────────────────────────────────
  // STRATEGY
  // ──────────────────────────────────────────────

  private async determineStrategy(
    owner: string,
    repo: string,
    preferred?: PROpeningStrategy,
  ): Promise<PROpeningStrategy> {
    if (preferred === PROpeningStrategy.FORK) {
      return PROpeningStrategy.FORK;
    }
    try {
      const user = await this.octokit.users.getAuthenticated();
      const { data: permissions } = await this.octokit.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: user.data.login,
      });
      if (permissions.permission === 'admin' || permissions.permission === 'write') {
        return PROpeningStrategy.DIRECT;
      }
    } catch {
      logger.debug({ owner, repo }, 'No direct write access, falling back to fork');
    }
    try {
      await this.octokit.repos.createFork({ owner, repo });
      return PROpeningStrategy.FORK;
    } catch {
      logger.warn({ owner, repo }, 'Failed to create fork');
      throw new Error(`Cannot open PR: no write access and cannot fork ${owner}/${repo}`);
    }
  }

  private async getForkOwner(owner: string, repo: string): Promise<string> {
    const user = await this.octokit.users.getAuthenticated();
    const username = user.data.login;
    try {
      const { data: forks } = await this.octokit.repos.listForks({
        owner,
        repo,
        sort: 'newest',
        per_page: 1,
      });
      if (forks.length > 0 && forks[0]?.owner?.login === username) {
        return username;
      }
    } catch {
      // Fall through and create the fork.
    }
    await this.octokit.repos.createFork({ owner, repo });
    await this.delay(2000);
    return username;
  }

  // ──────────────────────────────────────────────
  // PR CREATION
  // ──────────────────────────────────────────────

  private openPullRequest(
    owner: string,
    repo: string,
    targetOwner: string,
    branchName: string,
    baseBranch: string,
    changes: BreakingChange[],
    options: PROptions,
  ): Promise<Awaited<ReturnType<Octokit['pulls']['create']>>> {
    const title = options.prTitle ?? this.generatePRTitle(changes);
    const body = options.prBody ?? this.generatePRBody(changes);
    return this.octokit.pulls.create({
      owner,
      repo,
      title,
      body,
      head: `${targetOwner}:${branchName}`,
      base: baseBranch,
      draft: options.draft ?? false,
      maintainer_can_modify: true,
    });
  }

  // ──────────────────────────────────────────────
  // MESSAGES
  // ──────────────────────────────────────────────

  private generatePRTitle(changes: BreakingChange[]): string {
    const types = [...new Set(changes.map(change => change.type))];
    return `🛡️ [Mantior] Auto-fix ${changes.length} breaking API change${changes.length > 1 ? 's' : ''} (${types.join(', ')})`;
  }

  private generatePRBody(changes: BreakingChange[]): string {
    const changeDetails = changes.map(change => `- \`${change.message}\``).join('\n');
    return `
## 🛡️ Mantior – Automated Migration PR

Mantior detected breaking changes in your upstream API and automatically fixed the affected call sites.

### 📊 Changes Applied

${changeDetails}

### 📋 Next Steps

1. ✅ **Review the changes** in the "Files changed" tab
2. ✅ **Run your tests** locally or wait for CI
3. ✅ **Approve and merge** when ready

### 🔍 What is Mantior?

Mantior is an AI agent that scans consumer codebases, detects breaking API changes, and opens production-ready PRs to fix them.

---

*This PR was generated automatically. Please review carefully before merging.*
`;
  }

  private generateCommitMessage(changes: BreakingChange[]): string {
    const details = changes.map(change => `- ${change.message}`).join('\n');
    return `fix: auto-resolve breaking API changes\n\n${details}\n\nGenerated by Mantior`;
  }

  private generateBranchName(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    return `${BRANCH_PREFIX}-${timestamp}-${random}`;
  }

  // ──────────────────────────────────────────────
  // LABELS & REVIEWERS
  // ──────────────────────────────────────────────

  private async addLabels(
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[],
  ): Promise<void> {
    try {
      await this.octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels });
    } catch (error) {
      logger.warn({ owner, repo, prNumber, labels, error }, 'Failed to add labels');
    }
  }

  private async requestReviewers(
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[],
  ): Promise<void> {
    try {
      await this.octokit.pulls.requestReviewers({ owner, repo, pull_number: prNumber, reviewers });
    } catch (error) {
      logger.warn({ owner, repo, prNumber, reviewers, error }, 'Failed to request reviewers');
    }
  }

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────

  private delay(ms: number): Promise<void> {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
  }
}

export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const sshMatch = /git@github\.com:(.+)\/(.+)\.git/.exec(repoUrl);
  if (sshMatch) {
    return { owner: sshMatch[1] ?? '', repo: sshMatch[2] ?? '' };
  }
  const httpsMatch = /https?:\/\/github\.com\/(.+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
  if (httpsMatch) {
    return { owner: httpsMatch[1] ?? '', repo: httpsMatch[2] ?? '' };
  }
  const plainMatch = /^([^/]+)\/([^/]+)$/.exec(repoUrl);
  if (plainMatch) {
    return { owner: plainMatch[1] ?? '', repo: plainMatch[2] ?? '' };
  }
  return null;
}
