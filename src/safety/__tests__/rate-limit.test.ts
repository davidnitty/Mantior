import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { RateLimiter } from '../rate-limit';

describe('RateLimiter', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-ratelimit-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const limiter = (): RateLimiter =>
    new RateLimiter(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('allows up to the limit then blocks', () => {
    const rl = limiter();
    const ctx = { key: 'user-1', action: 'scan', limit: { window: 60_000, maxRequests: 2 } };

    const first = rl.allow(ctx);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    const second = rl.allow(ctx);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const third = rl.allow(ctx);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.resetIn).toBeGreaterThan(0);
  });

  it('resets after the window elapses', async () => {
    const rl = limiter();
    const ctx = { key: 'u', action: 'a', limit: { window: 30, maxRequests: 1 } };

    expect(rl.allow(ctx).allowed).toBe(true);
    expect(rl.allow(ctx).allowed).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(rl.allow(ctx).allowed).toBe(true);
  });

  it('tracks usage per key + action', () => {
    const rl = limiter();
    rl.allow({ key: 'k', action: 'a', limit: { window: 1000, maxRequests: 10 } });

    // getUsage reports against the default limit (100), not the caller's cap.
    const used = rl.getUsage('k', 'a');
    expect(used.count).toBe(1);
    expect(used.limit).toBe(100);
    expect(used.remaining).toBe(99);

    const fresh = rl.getUsage('other', 'a');
    expect(fresh.count).toBe(0);
    expect(fresh.limit).toBe(100);
  });

  it('resets usage for a key + action', () => {
    const rl = limiter();
    rl.allow({ key: 'k', action: 'a', limit: { window: 60_000, maxRequests: 5 } });
    expect(rl.getUsage('k', 'a').count).toBe(1);

    rl.reset('k', 'a');
    expect(rl.getUsage('k', 'a').count).toBe(0);
  });

  it('audits exceeded limits', () => {
    const rl = limiter();
    const ctx = { key: 'hog', action: 'llm', limit: { window: 60_000, maxRequests: 1 } };
    rl.allow(ctx);
    rl.allow(ctx);

    const hits = new AuditLogger(MantiorDatabase.getInstance(dbPath)).search({
      action: 'rate_limit_exceeded',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].metadata.key).toBe('hog');
  });
});
