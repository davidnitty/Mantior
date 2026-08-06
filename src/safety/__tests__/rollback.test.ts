import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { RollbackManager } from '../rollback';

describe('RollbackManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-rollback-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const manager = (): RollbackManager =>
    new RollbackManager(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('creates, lists and looks up plans', () => {
    const m = manager();
    const id = m.createPlan('deploy', [
      { id: 's1', type: 'revert', description: 'undo s1', execute: async () => {} },
    ]);

    expect(m.getPlan(id)?.status).toBe('pending');
    expect(m.listPlans()).toHaveLength(1);
    expect(m.hasPlan('deploy')).toBe(true);
    expect(m.hasPlan('elsewhere')).toBe(false);
  });

  it('executes steps in reverse order', async () => {
    const m = manager();
    const order: string[] = [];
    const id = m.createPlan('deploy', [
      {
        id: 's1',
        type: 'revert',
        description: 'first',
        execute: async () => {
          order.push('s1');
        },
      },
      {
        id: 's2',
        type: 'restore',
        description: 'second',
        execute: async () => {
          order.push('s2');
        },
      },
    ]);

    await m.executePlan(id);

    expect(order).toEqual(['s2', 's1']);
    expect(m.getPlan(id)?.status).toBe('completed');
  });

  it('continues best-effort and flags partial failures', async () => {
    const m = manager();
    const order: string[] = [];
    const id = m.createPlan('deploy', [
      {
        id: 'ok1',
        type: 'revert',
        description: '',
        execute: async () => {
          order.push('ok1');
        },
      },
      {
        id: 'bad',
        type: 'revert',
        description: '',
        execute: async () => {
          throw new Error('undo failed');
        },
      },
    ]);

    await expect(m.executePlan(id)).rejects.toThrow('Rollback completed with 1 errors');

    expect(order).toEqual(['ok1']);
    expect(m.getPlan(id)?.status).toBe('failed');
  });

  it('throws for unknown plans', async () => {
    await expect(manager().executePlan('nope')).rejects.toThrow('Rollback plan not found');
  });
});
