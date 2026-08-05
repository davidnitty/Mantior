import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { WorkflowEngine, type WorkflowContext } from '../workflow';

describe('WorkflowEngine', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-workflow-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const engine = (): WorkflowEngine =>
    new WorkflowEngine(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  async function waitForStatus(
    instance: WorkflowEngine,
    id: string,
    statuses: WorkflowContext['status'][],
    timeoutMs = 5000,
  ): Promise<WorkflowContext> {
    const started = Date.now();
    for (;;) {
      const ctx = instance.getStatus(id);
      if (ctx && statuses.includes(ctx.status)) {
        return ctx;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Workflow did not reach ${statuses.join('/')} in time`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('executes steps and completes', async () => {
    const instance = engine();
    const calls: string[] = [];
    const id = instance.startWorkflow(
      [
        {
          id: 's1',
          name: 'step one',
          action: async () => {
            calls.push('s1');
            return 1;
          },
        },
        {
          id: 's2',
          name: 'step two',
          action: async () => {
            calls.push('s2');
            return 2;
          },
        },
      ],
      { seed: true },
    );

    const ctx = await waitForStatus(instance, id, ['completed']);
    expect(ctx.status).toBe('completed');
    expect(calls).toEqual(['s1', 's2']);
  });

  it('retries failed steps', async () => {
    const instance = engine();
    let attempts = 0;
    const id = instance.startWorkflow(
      [
        {
          id: 'flaky',
          name: 'flaky step',
          retries: 2,
          action: async () => {
            attempts++;
            if (attempts < 3) {
              throw new Error('transient failure');
            }
            return 'ok';
          },
        },
      ],
      null,
    );

    const ctx = await waitForStatus(instance, id, ['completed']);
    expect(ctx.status).toBe('completed');
    expect(attempts).toBe(3);
  }, 15_000);

  it('runs rollbacks when a step fails', async () => {
    const instance = engine();
    const rolledBack: string[] = [];
    const id = instance.startWorkflow(
      [
        {
          id: 's1',
          name: 'first',
          rollback: async () => {
            rolledBack.push('s1');
          },
          action: async () => 'done',
        },
        {
          id: 's2',
          name: 'second',
          rollback: async () => {
            rolledBack.push('s2');
          },
          action: async () => {
            throw new Error('boom');
          },
        },
      ],
      null,
    );

    const ctx = await waitForStatus(instance, id, ['rolled_back', 'failed']);
    expect(ctx.status).toBe('rolled_back');
    expect(rolledBack).toEqual(['s2', 's1']);
  });

  it('waits for human approval and proceeds when approved', async () => {
    const instance = engine();
    const id = instance.startWorkflow(
      [
        {
          id: 'gated',
          name: 'gated step',
          requiresApproval: true,
          action: async () => 'approved-output',
        },
      ],
      null,
    );

    instance.once('approval:required', () => {
      instance.approve(id, 'gated', 'reviewer');
    });

    const ctx = await waitForStatus(instance, id, ['completed']);
    expect(ctx.status).toBe('completed');
    expect(ctx.output).toBe('approved-output');
  });

  it('fails when approval is rejected', async () => {
    const instance = engine();
    const id = instance.startWorkflow(
      [
        {
          id: 'gated',
          name: 'gated step',
          requiresApproval: true,
          action: async () => 'never',
        },
      ],
      null,
    );

    instance.once('approval:required', () => {
      instance.reject(id, 'gated', 'reviewer');
    });

    const ctx = await waitForStatus(instance, id, ['failed']);
    expect(ctx.status).toBe('failed');
  });
});
