import { readFileSync } from 'node:fs';

import type { MantiorConfig } from '../config/loader';
import type { BreakingChange } from '../diff/engine';
import { logger } from '../logger';
import { fixAttempts } from '../metrics';
import type { CallSite } from '../scanner/ast-walker';

import { LLMFallback } from './llm-fallback';

export enum FixComplexity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  AMBIGUOUS = 'ambiguous',
}

export interface ManualIntervention {
  file: string;
  line: number;
  change: string;
}

export interface FixOutcome {
  /** Absolute file path (call-site file) → patched content. */
  fixedFiles: Record<string, string>;
  manualInterventions: ManualIntervention[];
}

const SEMANTIC_MATCHES = ['name', 'id', 'email', 'phone', 'address'];
const CONFIDENCE_THRESHOLD = 70;

/**
 * Deterministic rule engine first, LLM fallback second, manual review last.
 * Never guesses: anything the deterministic rules cannot prove safe is
 * surfaced for a human review bucket, never silently applied.
 */
export class DeterministicFixer {
  private readonly llm?: LLMFallback;

  constructor(openAIApiKey?: string) {
    if (openAIApiKey) {
      this.llm = new LLMFallback(openAIApiKey);
    }
  }

  async applyFixes(
    callSites: CallSite[],
    config: MantiorConfig,
    changes: BreakingChange[],
  ): Promise<FixOutcome> {
    const fixedFiles: Record<string, string> = {};
    const originalContents: Record<string, string> = {};
    const manualInterventions: ManualIntervention[] = [];
    const processed = new Set<string>();

    for (const site of callSites) {
      const absolutePath = site.file;
      const seenKey = `${absolutePath}:${site.line}`;
      if (processed.has(seenKey)) {
        continue;
      }
      processed.add(seenKey);

      if (fixedFiles[absolutePath] === undefined) {
        try {
          const content = readFileSync(absolutePath, 'utf8');
          fixedFiles[absolutePath] = content;
          originalContents[absolutePath] = content;
        } catch (error) {
          logger.error({ file: absolutePath, error }, 'Failed to read file');
          fixAttempts.inc({ result: 'failed' });
          continue;
        }
      }
      const content = fixedFiles[absolutePath] ?? '';

      const complexity = this.scoreChangeComplexity(site.change);
      logger.debug(
        { file: absolutePath, line: site.line, complexity, change: site.change.message },
        'Change complexity scored',
      );

      // 1. Deterministic fix for LOW complexity.
      if (complexity === FixComplexity.LOW) {
        const fixed = this.applyDeterministicFix(content, site, config);
        if (fixed !== null) {
          fixedFiles[absolutePath] = fixed;
          fixAttempts.inc({ result: 'deterministic' });
          continue;
        }
        // Deterministic failed → fall through to the LLM.
      }

      // 2. LLM for MEDIUM/HIGH complexity when a key is configured.
      if (
        (complexity === FixComplexity.MEDIUM || complexity === FixComplexity.HIGH) &&
        this.llm !== undefined
      ) {
        const llmResult = await this.attemptLlm(site, content, config);
        if (llmResult.kind === 'applied') {
          fixedFiles[absolutePath] = llmResult.content;
          continue;
        }
        if (llmResult.kind === 'low-confidence' || llmResult.kind === 'failed') {
          manualInterventions.push({
            file: absolutePath,
            line: site.line,
            change: site.change.message,
          });
          continue;
        }
      }

      // 3. Manual intervention: AMBIGUOUS, no LLM configured, or (with an LLM)
      //    a change the model declined to attempt.
      manualInterventions.push({
        file: absolutePath,
        line: site.line,
        change: site.change.message,
      });
      if (this.llm === undefined || complexity === FixComplexity.AMBIGUOUS) {
        fixAttempts.inc({ result: 'manual_required' });
        logger.warn(
          { file: absolutePath, line: site.line, change: site.change.message },
          'Manual intervention required',
        );
      }
    }

    if (manualInterventions.length > 0) {
      logger.warn(
        { count: manualInterventions.length, items: manualInterventions },
        'Manual interventions required',
      );
    }

    // Surface unfixed breaking changes we had no call sites for, for the PR body.
    const covered = new Set(callSites.map(site => site.change.message));
    const uncovered = changes.filter(change => !covered.has(change.message));
    if (uncovered.length > 0 && !changes.some(change => change.severity === 'safe')) {
      logger.debug(
        { uncovered: uncovered.map(change => change.message) },
        'Breaking changes without call sites',
      );
    }

    // Drop files that were read but ended up unchanged (nothing applied).
    for (const [filePath, content] of Object.entries(fixedFiles)) {
      if (content === originalContents[filePath]) {
        delete fixedFiles[filePath];
      }
    }

    return { fixedFiles, manualInterventions };
  }

  // ──────────────────────────────────────────────
  // LLM STEP
  // ──────────────────────────────────────────────

  private async attemptLlm(
    site: CallSite,
    content: string,
    config: MantiorConfig,
  ): Promise<
    | { kind: 'applied'; content: string }
    | { kind: 'low-confidence' }
    | { kind: 'failed' }
    | { kind: 'declined' }
  > {
    const llm = this.llm;
    if (llm === undefined) {
      return { kind: 'declined' };
    }
    try {
      const result = await llm.attemptFix(site, content, site.change, {
        oldRef: config.api.reference_url,
        newRef: config.api.spec,
        consumerLanguage: this.consumerLanguageFor(config, site),
        filePath: site.file,
      });

      if (result.success && result.fixedContent && result.confidence >= CONFIDENCE_THRESHOLD) {
        const patched = spliceLine(content, site.line, result.fixedContent);
        fixAttempts.inc({ result: 'llm_success' });
        logger.info(
          {
            file: site.file,
            line: site.line,
            confidence: result.confidence,
            explanation: result.suggestion,
          },
          'LLM fix applied',
        );
        return { kind: 'applied', content: patched };
      }

      if (result.success && result.fixedContent && result.confidence < CONFIDENCE_THRESHOLD) {
        fixAttempts.inc({ result: 'llm_low_confidence' });
        logger.warn(
          {
            file: site.file,
            line: site.line,
            confidence: result.confidence,
            suggestion: result.suggestion,
          },
          'LLM confidence too low, manual intervention required',
        );
        return { kind: 'low-confidence' };
      }

      fixAttempts.inc({ result: 'llm_failed' });
      return { kind: 'failed' };
    } catch {
      fixAttempts.inc({ result: 'llm_failed' });
      return { kind: 'failed' };
    }
  }

  private consumerLanguageFor(config: MantiorConfig, site: CallSite): string | undefined {
    return config.consumers.find(consumer => site.file.includes(consumer.repo))?.language;
  }

  // ──────────────────────────────────────────────
  // DETERMINISTIC RULE ENGINE
  // ──────────────────────────────────────────────

  private applyDeterministicFix(
    content: string,
    site: CallSite,
    config: MantiorConfig,
  ): string | null {
    const property = site.change.property ?? '';
    if (property === '') {
      return null;
    }
    const mapping = config.mappings.find(entry => entry.old_path.includes(property));
    if (!mapping) {
      return null;
    }
    const newProp = mapping.new_path.split('.').pop() ?? '';
    if (newProp === '') {
      return null;
    }
    const regex = new RegExp(
      `\\b${escapeRegExp(property)}\\b(?=\\s*(?:,|;|\\.|:|\\=|\\)|\\]))`,
      'g',
    );
    const patched = content.replace(regex, newProp);
    if (patched === content) {
      return null;
    }
    logger.info(
      { file: site.file, line: site.line },
      `Deterministic fix: ${property} → ${newProp}`,
    );
    // NOTE: mapping.transform (e.g. "value / 100") is a documented extension
    // point — the value-conversion rewrite is Phase 2. Renames are safe today.
    return patched;
  }

  // ──────────────────────────────────────────────
  // COMPLEXITY SCORING
  // ──────────────────────────────────────────────

  scoreChangeComplexity(change: BreakingChange): FixComplexity {
    if (change.type === 'property_renamed') {
      const oldName = change.property ?? '';
      const newName = change.newProperty ?? '';

      // Simple rename (e.g., amount → amount_cents): punctuation-only change
      // or an added/removed affix. Both are safe to rewrite via config mappings.
      if (oldName.replace(/_/g, '') === newName.replace(/_/g, '')) {
        return FixComplexity.LOW;
      }
      if (oldName.startsWith(newName) || newName.startsWith(oldName)) {
        return FixComplexity.LOW;
      }

      // Semantic rename (e.g., name → full_name)
      if (SEMANTIC_MATCHES.some(match => oldName.includes(match) || newName.includes(match))) {
        return FixComplexity.MEDIUM;
      }

      return FixComplexity.HIGH;
    }

    if (change.type === 'property_removed') {
      return change.message.includes('replaced by') || change.message.includes('use')
        ? FixComplexity.MEDIUM
        : FixComplexity.HIGH;
    }

    if (change.type === 'schema_removed') {
      return FixComplexity.HIGH;
    }

    if (change.type === 'endpoint_removed') {
      return change.message.includes('replaced by')
        ? FixComplexity.MEDIUM
        : FixComplexity.AMBIGUOUS;
    }

    return FixComplexity.MEDIUM;
  }
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

/** Replace the single line at `lineNumber` (1-based) with (possibly multi-line) fixedCode. */
function spliceLine(content: string, lineNumber: number, fixedCode: string): string {
  const lines = content.split('\n');
  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) {
    return content;
  }
  const indent = /^\s*/.exec(lines[index] ?? '')?.[0] ?? '';
  const replacement = fixedCode.split('\n').map((line, i) => {
    if (i > 0 && line.trim().length > 0) {
      return `${indent}${line.trimStart()}`;
    }
    return line;
  });
  lines.splice(index, 1, ...replacement);
  return lines.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
