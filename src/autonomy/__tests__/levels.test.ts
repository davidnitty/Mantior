import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { BreakingChange } from '../../diff/engine';
import type { ConfidenceScore } from '../../fixer/confidence';
import { MantiorDatabase } from '../../state/database';
import { AutonomyLevel, AutonomyManager } from '../levels';

describe('AutonomyManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-autonomy-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const confidence = (score: number): ConfidenceScore => ({ score, factors: ['test'] });
  const manager = (level?: AutonomyLevel): AutonomyManager =>
    new AutonomyManager(level, MantiorDatabase.getInstance(dbPath));

  const renameChange: BreakingChange = {
    type: 'property_renamed',
    severity: 'breaking',
    property: 'amount',
    newProperty: 'amount_cents',
    message: 'Property "amount" renamed to "amount_cents".',
    confidence: 90,
  };

  it('defaults to Level 4 (execute with approval)', () => {
    expect(manager().getCurrentLevel()).toBe(AutonomyLevel.EXECUTE_WITH_APPROVAL);
  });

  it('auto-executes mechanical renames at level 5 with high confidence', () => {
    const permissions = manager(AutonomyLevel.EXECUTE_AUTOMATIC).getActionPermissions(
      renameChange,
      confidence(95),
    );
    expect(permissions.action).toBe('auto_execute');
    expect(permissions.requiresApproval).toBe(false);
  });

  it('downgrades to a lower action when confidence is below the level threshold', () => {
    const permissions = manager(AutonomyLevel.EXECUTE_AUTOMATIC).getActionPermissions(
      renameChange,
      confidence(60),
    );
    expect(permissions.action).toBe('simulate');
    expect(permissions.requiresApproval).toBe(true);
    expect(permissions.reason).toContain('Confidence');
  });

  it('never automates restricted change types', () => {
    const permissions = manager(AutonomyLevel.EXECUTE_AUTOMATIC).getActionPermissions(
      {
        type: 'schema_drop',
        severity: 'breaking',
        message: 'x',
        confidence: 100,
      } as unknown as BreakingChange,
      confidence(99),
    );
    expect(permissions.allowed).toBe(false);
    expect(permissions.action).toBe('manual_required');
    expect(permissions.requiresApproval).toBe(true);
  });

  it('always requires approval for schema/endpoint removal', () => {
    const permissions = manager(AutonomyLevel.EXECUTE_AUTOMATIC).getActionPermissions(
      {
        type: 'schema_removed',
        severity: 'breaking',
        message: 'x',
        confidence: 100,
      } as BreakingChange,
      confidence(98),
    );
    expect(permissions.requiresApproval).toBe(true);
  });

  it('caps the effective level by change-type override (never upgrades)', () => {
    // Override for property_renamed is EXECUTE_AUTOMATIC; user level 3 caps it.
    const permissions = manager(AutonomyLevel.SIMULATE).getActionPermissions(
      renameChange,
      confidence(99),
    );
    expect(permissions.action).toBe('simulate');
  });

  it('persists the user level between instances', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    const first = new AutonomyManager(undefined, db);
    first.setUserLevel(AutonomyLevel.OBSERVE);

    const reloaded = new AutonomyManager(undefined, db);
    expect(reloaded.getCurrentLevel()).toBe(AutonomyLevel.OBSERVE);
  });
});
