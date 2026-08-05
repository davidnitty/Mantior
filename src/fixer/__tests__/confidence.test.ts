import { describe, expect, it } from '@jest/globals';

import type { BreakingChange } from '../../diff/engine';
import { ConfidenceCalculator } from '../confidence';

const base = { severity: 'breaking' as const, confidence: 80, message: 'x' };

describe('ConfidenceCalculator', () => {
  const calculator = new ConfidenceCalculator();

  it('boosts mechanical renames above the engine heuristic', () => {
    const result = calculator.calculate(
      {
        type: 'property_renamed',
        property: 'amount',
        newProperty: 'amount_cents',
        ...base,
      } as BreakingChange,
      {},
    );
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.factors.some(factor => factor.includes('affix'))).toBe(true);
  });

  it('scores punctuation-only renames near-certain', () => {
    const result = calculator.calculate(
      {
        type: 'property_renamed',
        property: 'user_id',
        newProperty: 'userId',
        ...base,
      } as BreakingChange,
      {},
    );
    expect(result.score).toBeGreaterThanOrEqual(92);
  });

  it('caps unverified-severity changes', () => {
    const result = calculator.calculate(
      {
        type: 'property_removed',
        severity: 'safe',
        confidence: 90,
        message: 'x',
      } as BreakingChange,
      {},
    );
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.factors.some(factor => factor.includes('unverified'))).toBe(true);
  });

  it('clamps scores to 0-100', () => {
    const result = calculator.calculate(
      {
        type: 'schema_removed',
        severity: 'breaking',
        confidence: 120,
        message: 'x',
      } as BreakingChange,
      {},
    );
    expect(result.score).toBe(100);
  });
});
