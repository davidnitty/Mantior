import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { AutonomyLevel, AutonomyManager } from '../../autonomy/levels';
import { MantiorDatabase } from '../../state/database';
import { PolicyEngine, type PolicyContext } from '../engine';

describe('PolicyEngine', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-policy-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const baseContext = (overrides: Partial<PolicyContext>): PolicyContext => ({
    changeType: 'property_renamed',
    changeMessage: 'Property "amount" renamed to "amount_cents".',
    confidenceScore: 90,
    consumerRepo: 'acme/web',
    initiator: 'test',
    autonomyLevel: AutonomyLevel.EXECUTE_WITH_APPROVAL,
    severity: 'medium',
    affectedServices: ['web'],
    ...overrides,
  });

  const engine = (level: AutonomyLevel): PolicyEngine =>
    new PolicyEngine(
      new AuditLogger(MantiorDatabase.getInstance(dbPath)),
      new AutonomyManager(level, MantiorDatabase.getInstance(dbPath)),
    );

  it('flags critical changes for review', () => {
    const result = engine(AutonomyLevel.EXECUTE_WITH_APPROVAL).evaluate(
      baseContext({ severity: 'critical' }),
    );
    expect(result.results.some(r => r.action.type === 'approve')).toBe(true);
  });

  it('flags low-confidence changes', () => {
    const result = engine(AutonomyLevel.EXECUTE_WITH_APPROVAL).evaluate(
      baseContext({ confidenceScore: 30 }),
    );
    expect(result.results.some(r => r.action.type === 'flag')).toBe(true);
  });

  it('approves sensitive-endpoint changes', () => {
    const result = engine(AutonomyLevel.EXECUTE_WITH_APPROVAL).evaluate(
      baseContext({ changeMessage: 'Payment endpoint response changed' }),
    );
    expect(result.results.some(r => r.action.type === 'approve')).toBe(true);
  });

  it('auto-allows at Level 5 with high confidence', () => {
    const result = engine(AutonomyLevel.EXECUTE_AUTOMATIC).evaluate(
      baseContext({ autonomyLevel: AutonomyLevel.EXECUTE_AUTOMATIC, confidenceScore: 95 }),
    );
    expect(result.action.type).toBe('allow');
    expect(result.action.requiresReview).toBe(false);
  });

  it('requires review at Level 5 when confidence is below 90%', () => {
    const result = engine(AutonomyLevel.EXECUTE_AUTOMATIC).evaluate(
      baseContext({ autonomyLevel: AutonomyLevel.EXECUTE_AUTOMATIC, confidenceScore: 80 }),
    );
    expect(result.action.type).toBe('flag');
    expect(result.action.requiresReview).toBe(true);
  });

  it('lists configured policies', () => {
    const policies = engine(AutonomyLevel.EXECUTE_WITH_APPROVAL).getPolicies();
    expect(policies.map(p => p.id)).toEqual(
      expect.arrayContaining([
        'critical-changes',
        'sensitive-endpoints',
        'low-confidence',
        'multi-service',
        'new-endpoints',
      ]),
    );
  });
});
