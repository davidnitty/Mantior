import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { CostController } from '../../cost-control';
import type { BreakingChange } from '../../diff/engine';
import type { CallSite } from '../../scanner/ast-walker';
import { MantiorDatabase } from '../../state/database';
import { FixComplexity } from '../deterministic';
import { LLMRouter } from '../llm-router';

const callSite: CallSite = {
  file: '/tmp/consumer/payment.ts',
  line: 1,
  column: 1,
  node: null,
  change: {} as BreakingChange,
  matchText: 'response.amount',
  context: {
    surroundingCode: 'const total = response.amount;',
    objectChain: ['response', 'amount'],
  },
};

const change: BreakingChange = {
  type: 'property_renamed',
  severity: 'breaking',
  property: 'amount',
  newProperty: 'amount_cents',
  message: 'Property "amount" renamed to "amount_cents".',
  confidence: 80,
};

describe('LLMRouter', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-router-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const routerWith = (
    config: Partial<ConstructorParameters<typeof CostController>[0]>,
  ): LLMRouter => new LLMRouter(new CostController(config, MantiorDatabase.getInstance(dbPath)));

  it('routes LOW complexity to the cheapest tier (gpt-4o-mini)', () => {
    const result = routerWith({}).route(callSite, change, FixComplexity.LOW);
    expect(result.model.model).toBe('gpt-4o-mini');
    expect(result.shouldFallback).toBe(false);
  });

  it('routes HIGH complexity to the cheapest capable tier (gpt-4o)', () => {
    const result = routerWith({}).route(callSite, change, FixComplexity.HIGH);
    expect(result.model.model).toBe('gpt-4o');
    expect(result.shouldFallback).toBe(false);
  });

  it('routes AMBIGUOUS complexity to gpt-4-turbo-preview', () => {
    const result = routerWith({}).route(callSite, change, FixComplexity.AMBIGUOUS);
    expect(result.model.model).toBe('gpt-4-turbo-preview');
  });

  it('hard-stops when caps are exhausted', () => {
    const router = routerWith({ maxCostPerDay: 1, maxCostPerMonth: 100, maxCostPerScan: 100 });
    router.trackCall(
      {
        model: 'gpt-4o',
        costPerInputToken: 0.000005,
        costPerOutputToken: 0.000015,
        maxTokens: 8192,
        minConfidence: 85,
        bestFor: [FixComplexity.HIGH],
      },
      { input: 200_000, output: 40_000 },
    );

    const result = router.route(callSite, change, FixComplexity.HIGH);
    expect(result.shouldFallback).toBe(true);
    expect(result.reason).toContain('Daily');
    expect(result.model.model).toBe('gpt-4o-mini');
  });

  it('tracks actual usage against the cost controller', () => {
    const controller = new CostController(
      { maxCostPerDay: 5, maxCostPerMonth: 100, maxCostPerScan: 100 },
      MantiorDatabase.getInstance(dbPath),
    );
    const router = new LLMRouter(controller);
    router.trackCall(
      {
        model: 'gpt-4o-mini',
        costPerInputToken: 0.00000015,
        costPerOutputToken: 0.0000006,
        maxTokens: 4096,
        minConfidence: 70,
        bestFor: [FixComplexity.MEDIUM],
      },
      { input: 1000, output: 200 },
    );
    expect(controller.getTodayCost()).toBeGreaterThan(0);
  });
});
