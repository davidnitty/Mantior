import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { DryRunManager } from '../dry-run';

describe('DryRunManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-dryrun-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const manager = (): DryRunManager =>
    new DryRunManager(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  const context = { workflowId: 'wf_test', initiator: 'test' };

  it('simulates an action without side effects', async () => {
    const result = await manager().simulate(async () => 42, 'update charge', context);

    expect(result.mode).toBe('dry-run');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe('simulated');
    expect(result.actions[0].requiresApproval).toBe(true);
    expect(result.actions[0].risk).toBe('low');
    expect(result.impacts[0]).toContain('components');
    expect(result.warnings[0]).toContain('dry-run');
  });

  it('never fails when the action would have failed', async () => {
    const result = await manager().simulate(
      async () => {
        throw new Error('boom');
      },
      'risky op',
      context,
    );

    expect(result.mode).toBe('dry-run');
    expect(result.actions[0].change).toContain('null');
  });

  it('previews a single change', async () => {
    const action = await manager().preview(async () => 'done', 'preview op', context);

    expect(action.type).toBe('preview');
    expect(action.requiresApproval).toBe(true);
    expect(action.before.timestamp).toBeDefined();
  });

  it('audits completed dry runs', async () => {
    await manager().simulate(async () => 1, 'audited op', context);

    const hits = new AuditLogger(MantiorDatabase.getInstance(dbPath)).search({
      action: 'dry_run_completed',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].metadata.workflowId).toBe(context.workflowId);
  });
});
