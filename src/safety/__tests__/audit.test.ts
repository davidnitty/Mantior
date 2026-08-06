import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { MantiorDatabase } from '../../state/database';
import { SafetyAuditLogger } from '../audit';

describe('SafetyAuditLogger', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-safety-audit-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const audit = (): SafetyAuditLogger => new SafetyAuditLogger(MantiorDatabase.getInstance(dbPath));

  it('logs safety events with before/after state', () => {
    audit().logSafetyEvent(
      'deploy.started',
      { operation: 'deploy', userId: 'alice', resource: 'workers', actionType: 'write' },
      { before: { version: 1 }, after: { version: 2 }, reason: 'auto-deploy' },
    );

    const hits = audit().search({ action: 'safety.deploy.started' });
    expect(hits).toHaveLength(1);
    expect(hits[0].userId).toBe('alice');
    expect(hits[0].metadata.operation).toBe('deploy');
    expect(hits[0].metadata.reason).toBe('auto-deploy');
  });

  it('logs violations', () => {
    audit().logViolation('bob', 'restart', 'database', 'no permission');

    const hits = audit().search({ action: 'safety.violation' });
    expect(hits).toHaveLength(1);
    expect(hits[0].metadata.resource).toBe('database');
  });

  it('logs approvals', () => {
    audit().logApproval('apr_1', 'admin', 'approved', 'looks good');

    const hits = audit().search({ action: 'safety.approval.approved' });
    expect(hits).toHaveLength(1);
    expect(hits[0].metadata.requestId).toBe('apr_1');
  });

  it('logs rollback lifecycle events', () => {
    const a = audit();
    a.logRollback('rb_1', 'system', 'started');
    a.logRollback('rb_1', 'system', 'completed', { reason: 'reverted' });

    expect(a.search({ action: 'safety.rollback.started' })).toHaveLength(1);
    const completed = a.search({ action: 'safety.rollback.completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].metadata.reason).toBe('reverted');
  });
});
