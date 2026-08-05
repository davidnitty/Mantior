import type { CostController, LLMTokens } from '../cost-control';
import type { BreakingChange } from '../diff/engine';
import type { CallSite } from '../scanner/ast-walker';

import type { FixComplexity } from './deterministic';

export interface LLMModelConfig {
  model: string;
  costPerInputToken: number;
  costPerOutputToken: number;
  maxTokens: number;
  minConfidence: number;
  bestFor: FixComplexity[];
}

/** Model tiers, cheapest first — the router always prefers the cheapest fit. */
export const MODELS: LLMModelConfig[] = [
  {
    model: 'gpt-4o-mini',
    costPerInputToken: 0.00000015,
    costPerOutputToken: 0.0000006,
    maxTokens: 4096,
    minConfidence: 70,
    bestFor: ['low', 'medium'],
  },
  {
    model: 'gpt-4o',
    costPerInputToken: 0.000005,
    costPerOutputToken: 0.000015,
    maxTokens: 8192,
    minConfidence: 85,
    bestFor: ['high'],
  },
  {
    model: 'gpt-4-turbo-preview',
    costPerInputToken: 0.00001,
    costPerOutputToken: 0.00003,
    maxTokens: 8192,
    minConfidence: 90,
    bestFor: ['high', 'ambiguous'],
  },
];

export interface RouteResult {
  model: LLMModelConfig;
  /** True when cost caps blocked the call — do not invoke the LLM. */
  shouldFallback: boolean;
  reason?: string;
}

/**
 * Cost-aware model selection. Always routes to the cheapest model capable of
 * the change's complexity, downgrades when a single call would exceed 10% of
 * the remaining daily budget, and hard-stops when caps are exhausted.
 */
export class LLMRouter {
  constructor(private readonly costController: CostController) {}

  route(callSite: CallSite, _change: BreakingChange, complexity: FixComplexity): RouteResult {
    const costCheck = this.costController.canProceed();
    if (!costCheck.allowed) {
      return { model: MODELS[0], shouldFallback: true, reason: costCheck.reason };
    }

    const candidates = MODELS.filter(model => model.bestFor.includes(complexity));
    if (candidates.length === 0) {
      return {
        model: MODELS[0],
        shouldFallback: false,
        reason: 'No model found for complexity, using default',
      };
    }

    const selected = [...candidates].sort((a, b) => a.costPerInputToken - b.costPerInputToken)[0];

    const estimatedCost = this.estimateCost(callSite, selected);
    const remainingBudget = this.costController.getRemainingBudget();
    if (remainingBudget > 0 && estimatedCost > remainingBudget * 0.1) {
      const cheaper = MODELS.find(
        model =>
          model.costPerInputToken < selected.costPerInputToken &&
          model.bestFor.includes(complexity),
      );
      if (cheaper) {
        return {
          model: cheaper,
          shouldFallback: false,
          reason: `Downgraded due to budget: estimated $${estimatedCost.toFixed(4)}`,
        };
      }
    }

    return { model: selected, shouldFallback: false };
  }

  /** Record actual token usage against the cost controller. */
  trackCall(model: LLMModelConfig, tokens: LLMTokens): void {
    const cost = tokens.input * model.costPerInputToken + tokens.output * model.costPerOutputToken;
    this.costController.trackLLMCall(model.model, tokens, cost);
  }

  estimateCost(callSite: CallSite, model: LLMModelConfig): number {
    const codeLength = callSite.context.surroundingCode?.length ?? 500;
    const estimatedTokens = Math.ceil(codeLength / 4);
    const inputCost = estimatedTokens * model.costPerInputToken;
    const outputCost = 200 * model.costPerOutputToken;
    return inputCost + outputCost;
  }
}
