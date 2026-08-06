import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { IdempotencyManager } from '../idempotency';

describe('IdempotencyManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-idem-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    jest.useRealTimers();
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const idem = (): IdempotencyManager =>
    new IdempotencyManager(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('generates stable keys for the same operation + params', () => {
    const m = idem();
    const a = m.generateKey('fix', { x: 1 });
    const b = m.generateKey('fix', { x: 1 });
    const c = m.generateKey('fix', { x: 2 });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('executes once and replays the cached result', async () => {
    let calls = 0;
    const m = idem();
    const key = m.generateKey('fix', { repo: 'acme/web' });

    const first = await m.execute(
      key,
      'fix',
      async () => {
        calls++;
        return { fixed: true, count: 3 };
      },
      { repo: 'acme/web' },
    );
    expect(first.isCached).toBe(false);
    expect(first.result).toEqual({ fixed: true, count: 3 });

    const second = await m.execute(
      key,
      'fix',
      async () => {
        calls++;
        return { fixed: true, count: 3 };
      },
      { repo: 'acme/web' },
    );
    expect(second.isCached).toBe(true);
    expect(calls).toBe(1);
  });

  it('re-executes after a failed attempt', async () => {
    let calls = 0;
    const m = idem();
    const key = 'retry-key';

    await expect(
      m.execute(
        key,
        'op',
        async () => {
          calls++;
          throw new Error('network down');
        },
        {},
      ),
    ).rejects.toThrow('network down');

    const retry = await m.execute(
      key,
      'op',
      async () => {
        calls++;
        return 'done';
      },
      {},
    );
    expect(retry.isCached).toBe(false);
    expect(calls).toBe(2);
  });

  it('reports store statistics', async () => {
    const m = idem();
    expect(m.check('missing')).toBeNull();

    await m.execute('k3', 'op', async () => 1, {});
    const stats = m.stats();
    expect(stats.total).toBe(1);
    expect(stats.completed).toBe(1);
  });

  it('expires and cleans up old entries', async () => {
    jest.useFakeTimers();
    const m = idem();
    const key = 'ttl-key';

    await m.execute(key, 'op', async () => 1, {});
    expect(m.check(key)).not.toBeNull();

    jest.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(m.check(key)).toBeNull();

    m.cleanup();
    expect(m.stats().total).toBe(0);
  });
});
