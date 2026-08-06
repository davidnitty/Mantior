import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { TimeoutManager } from '../timeouts';

describe('TimeoutManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-timeouts-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const manager = (config = {}): TimeoutManager =>
    new TimeoutManager(config, new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('resolves with the function result', async () => {
    const result = await manager().execute(async () => 'ok', {
      action: 'api_call',
      component: 'github_client',
      operationId: 'op-resolve',
    });
    expect(result).toBe('ok');
  });

  it('rejects when the operation exceeds its timeout', async () => {
    const m = manager({ byAction: { slow: 100 } });
    await expect(
      m.execute(() => new Promise<void>(() => {}), {
        action: 'slow',
        component: 'n/a',
        operationId: 'op-slow',
      }),
    ).rejects.toThrow('Operation timed out after 100ms');
    m.cleanupAll();
  });

  it('retries transient failures and succeeds', async () => {
    let attempts = 0;
    const m = manager({ byAction: { flaky: 1000 } });

    const result = await m.executeWithRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient');
        }
        return 'recovered';
      },
      { action: 'flaky', component: 'n/a', operationId: 'op-retry' },
      3,
      5,
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('gives up after retries are exhausted', async () => {
    const m = manager({ byAction: { doomed: 1000 } });
    await expect(
      m.executeWithRetry(
        async () => {
          throw new Error('always fails');
        },
        { action: 'doomed', component: 'n/a', operationId: 'op-doomed' },
        2,
        5,
      ),
    ).rejects.toThrow('always fails');
  });

  it('caps timeouts at the configured maximum', async () => {
    const m = manager({ byAction: { huge: 10_000 }, maxAllowed: 100 });
    // The audit log records the effective (capped) timeout.
    await expect(
      m.execute(() => new Promise<void>(() => {}), {
        action: 'huge',
        component: 'n/a',
        operationId: 'op-capped',
      }),
    ).rejects.toThrow('Operation timed out after 100ms');
    m.cleanupAll();
  });
});
