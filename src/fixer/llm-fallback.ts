import type { BreakingChange } from '../diff/engine';
import { logger } from '../logger';
import { fixAttempts } from '../metrics';
import type { CallSite } from '../scanner/ast-walker';

import type { FixComplexity } from './deterministic';
import { LLMRateLimiter } from './llm-rate-limit';
import type { LLMRouter } from './llm-router';

export interface LLMFixResult {
  success: boolean;
  fixedContent?: string;
  confidence: number;
  suggestion?: string;
  needsManualReview: boolean;
}

export interface LLMContext {
  oldRef?: string;
  newRef?: string;
  consumerLanguage?: string;
  filePath?: string;
}

export interface LLMCallResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

const CONFIDENCE_THRESHOLD = 70;
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4-turbo-preview';

function rateLimitFromEnv(): { maxConcurrent: number; maxPerMinute: number } {
  return {
    maxConcurrent: envNumber(process.env.LLM_MAX_CONCURRENT, 2),
    maxPerMinute: envNumber(process.env.LLM_CALLS_PER_MINUTE, 120),
  };
}

/**
 * OpenAI-backed fallback fixer. Called only for MEDIUM/HIGH complexity changes
 * the deterministic engine cannot resolve with confidence.
 *
 * Risk mitigations (Four Horsemen — Uncontrolled Costs):
 *  - LLM router picks the cheapest capable model and downgrades on budget.
 *  - CostController hard-stops calls when per-scan/day/month caps are hit.
 *  - Rate limiter bounds concurrency + per-minute burst.
 *  - Responses are cached by (file, line, change) so repeat scans don't burn tokens.
 */
export class LLMFallback {
  private readonly cache = new Map<string, LLMFixResult>();
  private readonly rateLimiter: LLMRateLimiter;

  constructor(
    private readonly openAIApiKey: string,
    private readonly router?: LLMRouter,
  ) {
    this.rateLimiter = new LLMRateLimiter(rateLimitFromEnv());
  }

  async attemptFix(
    callSite: CallSite,
    originalContent: string,
    change: BreakingChange,
    context: LLMContext,
    complexity: FixComplexity = 'medium',
  ): Promise<LLMFixResult> {
    if (!this.openAIApiKey) {
      logger.warn('OpenAI API key not configured, skipping LLM fallback');
      return {
        success: false,
        confidence: 0,
        needsManualReview: true,
        suggestion: 'OpenAI API key not configured. Manual review required.',
      };
    }

    const cacheKey = `${callSite.file}:${callSite.line}:${callSite.change.type}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Cost-aware routing: block the call entirely when caps are exhausted.
    const routed = this.router ? this.router.route(callSite, change, complexity) : undefined;
    if (routed && routed.shouldFallback) {
      logger.warn({ reason: routed.reason }, 'LLM call blocked by cost controls');
      fixAttempts.inc({ result: 'manual_required' });
      const result: LLMFixResult = {
        success: false,
        confidence: 0,
        needsManualReview: true,
        suggestion: routed.reason ?? 'LLM call blocked by cost controls. Manual review required.',
      };
      this.cache.set(cacheKey, result);
      return result;
    }
    const model = routed?.model.model ?? DEFAULT_MODEL;

    const prompt = this.buildPrompt(callSite, originalContent, change, context);
    try {
      await this.rateLimiter.acquire();
      let response: LLMCallResult;
      try {
        response = await this.callOpenAI(prompt, model);
      } finally {
        this.rateLimiter.release();
      }

      const result = this.parseResponse(response.content);

      if (result.success && result.confidence < CONFIDENCE_THRESHOLD) {
        logger.info(
          { confidence: result.confidence, file: context.filePath },
          'LLM confidence too low, marking for manual review',
        );
        result.needsManualReview = true;
      }

      // Record actual usage against the cost caps (only when a router is active).
      if (this.router && routed && (response.promptTokens > 0 || response.completionTokens > 0)) {
        this.router.trackCall(routed.model, {
          input: response.promptTokens,
          output: response.completionTokens,
        });
      }

      fixAttempts.inc({
        result: result.success && !result.needsManualReview ? 'llm_success' : 'llm_low_confidence',
      });
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'LLM fallback failed',
      );
      fixAttempts.inc({ result: 'llm_failed' });
      return {
        success: false,
        confidence: 0,
        needsManualReview: true,
        suggestion: `LLM error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ──────────────────────────────────────────────
  // PROMPT
  // ──────────────────────────────────────────────

  private buildPrompt(
    callSite: CallSite,
    originalContent: string,
    change: BreakingChange,
    context: LLMContext,
  ): string {
    const lines = originalContent.split('\n');
    const startLine = Math.max(0, callSite.line - 10);
    const endLine = Math.min(lines.length, callSite.line + 10);
    const surroundingCode = lines.slice(startLine, endLine).join('\n');

    return `
You are an expert API migration assistant for Mantior.

## Task
Fix the breaking API change in the code below.

## Breaking Change
Type: ${change.type}
Message: ${change.message}${change.property ? `\nOld Property: ${change.property}` : ''}${change.newProperty ? `\nNew Property: ${change.newProperty}` : ''}

## Code Context
Language: ${context.consumerLanguage ?? 'typescript'}
File: ${context.filePath ?? callSite.file}

\`\`\`
${surroundingCode}
\`\`\`

## Instructions
1. Identify the exact code that needs to change.
2. Apply the fix to make it compatible with the new API.
3. Preserve all existing logic and formatting.
4. If you cannot fix it with confidence, say so.

## Response Format
Return JSON:
{
  "success": true/false,
  "fixedCode": "the fixed code block (only the changed part)",
  "confidence": 0-100,
  "explanation": "brief explanation of what you changed"
}
`;
  }

  // ──────────────────────────────────────────────
  // OPENAI CALL
  // ──────────────────────────────────────────────

  private async callOpenAI(prompt: string, model: string): Promise<LLMCallResult> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openAIApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are Mantior, an AI agent that fixes breaking API changes in consumer codebases. You are precise, careful, and always preserve existing functionality.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  // ──────────────────────────────────────────────
  // RESPONSE PARSING
  // ──────────────────────────────────────────────

  private parseResponse(response: string): LLMFixResult {
    try {
      const parsed = JSON.parse(response) as {
        success?: unknown;
        fixedCode?: unknown;
        confidence?: unknown;
        explanation?: unknown;
      };
      const confidence = asNumber(parsed.confidence);
      const success = parsed.success === true;
      return {
        success,
        fixedContent: typeof parsed.fixedCode === 'string' ? parsed.fixedCode : undefined,
        confidence,
        suggestion: typeof parsed.explanation === 'string' ? parsed.explanation : undefined,
        needsManualReview: confidence < CONFIDENCE_THRESHOLD || !success,
      };
    } catch {
      logger.error({ response: response.slice(0, 200) }, 'Failed to parse LLM response');
      return {
        success: false,
        confidence: 0,
        needsManualReview: true,
        suggestion: 'Failed to parse LLM response. Manual review required.',
      };
    }
  }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
