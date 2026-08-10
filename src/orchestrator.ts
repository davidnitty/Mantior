import { relative } from 'node:path';

import { Octokit } from '@octokit/rest';

import { AutonomyLevel, AutonomyManager } from './autonomy/levels';
import { configHash, loadConfig, type MantiorConfig } from './config/loader';
import { costConfigFromEnv, CostController } from './cost-control';
import { DiffEngine, type BreakingChange } from './diff/engine';
import { ConfidenceCalculator } from './fixer/confidence';
import { DeterministicFixer } from './fixer/deterministic';
import { LLMRouter } from './fixer/llm-router';
import { PRDeduplicator } from './github/pr-dedupe';
import { PROpener, type PROpeningResult } from './github/pr-opener';
import { GraphQLDiffEngine } from './graphql/diff';
import { GraphQLClientScanner } from './graphql/scanner';
import { logger } from './logger';
import { errorsTotal, scansTotal } from './metrics';
import { Notifier } from './notifier';
import { ASTWalker } from './scanner/ast-walker';
import { RepoCloner } from './scanner/repo-cloner';
import { MantiorDatabase, type AutonomyLog } from './state/database';

export interface OrchestratorOptions {
  dryRun?: boolean;
}

export interface OrchestratorResult {
  status: 'success' | 'failed' | 'partial';
  changesDetected: number;
  consumersScanned: number;
  prsOpened: number;
  manualInterventions: number;
  errorsCount: number;
  durationSec: number;
}

interface ConsumerOutcome {
  repo: string;
  language: string;
  callSitesFound: number;
  prOpened: boolean;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  manualInterventions: number;
  error?: string;
}

/**
 * The core pipeline: diff → clone consumers → locate call sites → fix →
 * open PRs (direct/fork, deduped), recording every run to SQLite.
 */
export class Orchestrator {
  private readonly diffEngine = new DiffEngine();
  private readonly graphqlDiff = new GraphQLDiffEngine();
  private readonly cloner = new RepoCloner();
  private readonly walker = new ASTWalker();
  private readonly graphqlScanner = new GraphQLClientScanner();
  private readonly autonomyManager = new AutonomyManager();
  private readonly confidenceCalculator = new ConfidenceCalculator();
  private readonly notifier: Notifier;
  private readonly db = MantiorDatabase.getInstance();

  constructor(slackWebhook?: string) {
    this.notifier = new Notifier(slackWebhook);
  }

  async run(configPath: string, options: OrchestratorOptions = {}): Promise<OrchestratorResult> {
    const started = Date.now();
    scansTotal.inc();

    let config: MantiorConfig;
    try {
      config = loadConfig(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Config load failed');
      this.recordFailedScan(configPath, message);
      throw error;
    }

    let changes: BreakingChange[];
    try {
      changes =
        config.api.protocol === 'graphql'
          ? await this.graphqlDiff.compare(config.api.reference_url, config.api.spec)
          : await this.diffEngine.compare(config.api.reference_url, config.api.spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Diff failed');
      this.recordFailedScan(configPath, message);
      throw error;
    }
    logger.info({ changeCount: changes.length }, 'Diff complete');

    // Risk mitigation (Four Horsemen — Uncontrolled Costs): hard caps on LLM
    // spend, cost-aware model routing, and a HARD STOP once caps are hit.
    const costController = new CostController(costConfigFromEnv(), this.db, this.notifier);
    costController.beginScan();
    const llmRouter = new LLMRouter(costController);
    const costCheck = costController.canProceed();
    if (!costCheck.allowed) {
      logger.warn(
        { reason: costCheck.reason },
        'LLM cost caps already exhausted; LLM fallback disabled for this run',
      );
    }

    const fixer = new DeterministicFixer(process.env.OPENAI_API_KEY, llmRouter);
    const opener = new PROpener(config);
    const token = config.security.github_token ?? process.env.GITHUB_TOKEN;
    const deduper = new PRDeduplicator(
      new Octokit({ auth: token ?? '', userAgent: 'Mantior/1.0' }),
    );
    const userLevel = this.autonomyManager.getCurrentLevel();
    const canOpenPrs =
      config.rules.auto_pr &&
      !options.dryRun &&
      opener.enabled &&
      userLevel >= AutonomyLevel.EXECUTE_WITH_APPROVAL;
    const fixEnabled = userLevel >= AutonomyLevel.SIMULATE;
    if (!canOpenPrs) {
      logger.warn(
        {
          autoPr: config.rules.auto_pr,
          dryRun: options.dryRun ?? false,
          tokenConfigured: opener.enabled,
          autonomyLevel: AutonomyLevel[userLevel],
        },
        'PR opening disabled for this run',
      );
    }
    if (userLevel <= AutonomyLevel.RECOMMEND) {
      logger.warn(
        { autonomyLevel: AutonomyLevel[userLevel] },
        'Autonomy level: no code changes will be made (observe/recommend)',
      );
    }

    // Autonomy audit trail: one decision per breaking change, with the
    // confidence that justified it (Four Horsemen — Unreliable Actions).
    const autonomyDecisions: Array<Omit<AutonomyLog, 'id'>> = [];
    for (const change of changes) {
      const confidence = this.confidenceCalculator.calculate(change, {});
      const permissions = this.autonomyManager.getActionPermissions(change, confidence);
      autonomyDecisions.push({
        timestamp: new Date().toISOString(),
        scan_id: 0,
        change_type: change.type,
        change_message: change.message,
        requested_level: userLevel,
        effective_level: permissions.level,
        action_taken: permissions.action,
        confidence_score: confidence.score,
        requires_approval: permissions.requiresApproval,
      });
      logger.info(
        {
          change: change.message,
          level: AutonomyLevel[permissions.level],
          action: permissions.action,
          requiresApproval: permissions.requiresApproval,
          confidence: confidence.score,
        },
        'Autonomy check result',
      );
    }

    const consumers: ConsumerOutcome[] = [];
    for (const consumer of config.consumers) {
      const outcome = await this.processConsumer(
        consumer.repo,
        consumer.branch,
        consumer.language,
        config,
        changes,
        fixer,
        opener,
        deduper,
        canOpenPrs,
        fixEnabled,
      );
      consumers.push(outcome);
      if (outcome.error) {
        errorsTotal.inc({ module: 'consumer' });
      }
    }

    const durationSec = (Date.now() - started) / 1000;
    const errorsCount = consumers.filter(consumer => consumer.error !== undefined).length;
    const prsOpened = consumers.filter(consumer => consumer.prOpened).length;
    const manualInterventions = consumers.reduce(
      (total, consumer) => total + consumer.manualInterventions,
      0,
    );
    const status =
      errorsCount === 0 ? 'success' : consumers.length === errorsCount ? 'failed' : 'partial';

    this.recordRun(configPath, {
      timestamp: new Date().toISOString(),
      duration: durationSec,
      changes_detected: changes.length,
      consumers_scanned: consumers.length,
      prs_opened: prsOpened,
      errors_count: errorsCount,
      status,
      consumers,
      autonomyLogs: autonomyDecisions,
    });

    const summary: OrchestratorResult = {
      status,
      changesDetected: changes.length,
      consumersScanned: consumers.length,
      prsOpened,
      manualInterventions,
      errorsCount,
      durationSec,
    };

    await this.notifier.notify({
      text: `🛡️ Mantior scan finished: ${changes.length} change(s), ${prsOpened} PR(s), ${errorsCount} error(s)`,
      fields: {
        status,
        changes: String(changes.length),
        prs: String(prsOpened),
        errors: String(errorsCount),
      },
    });

    logger.info({ ...summary }, 'Orchestrator run completed');
    return summary;
  }

  // ──────────────────────────────────────────────
  // PER-CONSUMER PIPELINE
  // ──────────────────────────────────────────────

  private async processConsumer(
    repo: string,
    branch: string,
    language: string,
    config: MantiorConfig,
    changes: BreakingChange[],
    fixer: DeterministicFixer,
    opener: PROpener,
    deduper: PRDeduplicator,
    canOpenPrs: boolean,
    fixEnabled: boolean,
  ): Promise<ConsumerOutcome> {
    let dir: string | undefined;
    try {
      dir = await this.cloner.clone(repo, branch);
      logger.info({ repo }, 'Cloned consumer repository');

      const callSites =
        config.api.protocol === 'graphql'
          ? await this.graphqlScanner.findCallSites(dir, changes)
          : await this.walker.findCallSites(dir, changes, language);
      logger.info({ repo, callSites: callSites.length }, 'Call sites located');

      if (!fixEnabled) {
        logger.info({ repo }, 'Autonomy level: call sites located, but no fixes applied');
        return {
          repo,
          language,
          callSitesFound: callSites.length,
          prOpened: false,
          manualInterventions: 0,
        };
      }

      const outcome = await fixer.applyFixes(callSites, config, changes);
      const fixedFiles: Record<string, string> = {};
      for (const [absolutePath, content] of Object.entries(outcome.fixedFiles)) {
        fixedFiles[toPosix(relative(dir, absolutePath))] = content;
      }
      logger.info(
        { repo, files: Object.keys(fixedFiles).length, manual: outcome.manualInterventions.length },
        'Fixes applied',
      );

      const base: ConsumerOutcome = {
        repo,
        language,
        callSitesFound: callSites.length,
        prOpened: false,
        manualInterventions: outcome.manualInterventions.length,
      };

      if (Object.keys(fixedFiles).length === 0) {
        return base;
      }

      if (!canOpenPrs) {
        logger.info({ repo }, 'PR skipped (disabled, dry-run, or missing token)');
        return base;
      }

      const parsed = parseRepoForPr(repo);
      if (parsed) {
        const existing = await deduper.findExistingPR(parsed.owner, parsed.repo, '', changes);
        if (existing.exists) {
          logger.info({ repo, prUrl: existing.prUrl }, 'PR already open; skipping');
          return { ...base, prOpened: true, prUrl: existing.prUrl, prNumber: existing.prNumber };
        }
      }

      const result: PROpeningResult = await opener.createPR(
        dir,
        repo,
        branch,
        fixedFiles,
        changes,
        {
          labels: config.rules.pr_labels,
          reviewers: config.rules.default_reviewer ? [config.rules.default_reviewer] : undefined,
        },
      );
      return {
        ...base,
        prOpened: true,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
        branch: result.branchName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ repo, error: message }, 'Consumer processing failed');
      return {
        repo,
        language,
        callSitesFound: 0,
        prOpened: false,
        manualInterventions: 0,
        error: message,
      };
    } finally {
      if (dir !== undefined) {
        await this.cloner.cleanup(dir);
      }
    }
  }

  // ──────────────────────────────────────────────
  // PERSISTENCE
  // ──────────────────────────────────────────────

  private recordRun(
    configPath: string,
    run: {
      timestamp: string;
      duration: number;
      changes_detected: number;
      consumers_scanned: number;
      prs_opened: number;
      errors_count: number;
      status: 'success' | 'failed' | 'partial';
      consumers: ConsumerOutcome[];
      autonomyLogs: Array<Omit<AutonomyLog, 'id'>>;
    },
  ): void {
    try {
      const scanId = this.db.insertScan({
        timestamp: run.timestamp,
        duration: run.duration,
        changes_detected: run.changes_detected,
        consumers_scanned: run.consumers_scanned,
        prs_opened: run.prs_opened,
        errors_count: run.errors_count,
        status: run.status,
        config_hash: configHash(configPath),
      });
      for (const log of run.autonomyLogs) {
        this.db.insertAutonomyLog({ ...log, scan_id: scanId });
      }
      for (const consumer of run.consumers) {
        this.db.insertConsumer({
          scan_id: scanId,
          repo: consumer.repo,
          branch: 'main',
          language: consumer.language,
          call_sites_found: consumer.callSitesFound,
          pr_opened: consumer.prOpened,
          pr_url: consumer.prUrl,
        });
        if (consumer.prOpened && consumer.prNumber !== undefined) {
          this.db.insertPR({
            scan_id: scanId,
            repo: consumer.repo,
            pr_url: consumer.prUrl ?? '',
            pr_number: consumer.prNumber,
            branch: consumer.branch ?? `mantior/auto-fix-${Date.now()}`,
            status: 'open',
            created_at: run.timestamp,
            changes: '[]',
          });
        }
      }
      for (const consumer of run.consumers) {
        if (consumer.error) {
          this.db.insertError({
            scan_id: scanId,
            timestamp: run.timestamp,
            module: 'consumer',
            type: 'scan_error',
            message: consumer.error,
          });
        }
      }
    } catch (dbError) {
      logger.error({ error: dbError }, 'Failed to persist scan results');
    }
  }

  private recordFailedScan(configPath: string, message: string): void {
    try {
      const scanId = this.db.insertScan({
        timestamp: new Date().toISOString(),
        duration: 0,
        changes_detected: 0,
        consumers_scanned: 0,
        prs_opened: 0,
        errors_count: 1,
        status: 'failed',
        config_hash: configHash(configPath),
      });
      this.db.insertError({
        scan_id: scanId,
        timestamp: new Date().toISOString(),
        module: 'orchestrator',
        type: 'fatal',
        message,
      });
    } catch (dbError) {
      logger.error({ error: dbError }, 'Failed to record scan in database');
    }
  }
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function parseRepoForPr(repo: string): { owner: string; repo: string } | null {
  const trimmed = repo.trim().replace(/^git@/, '');
  const match = /(?:github\.com[/:])?([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const owner = match[1] ?? '';
  const name = match[2] ?? '';
  return owner !== '' && name !== '' ? { owner, repo: name } : null;
}

function toPosix(value: string): string {
  return value.split('\\').join('/');
}
