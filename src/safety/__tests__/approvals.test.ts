import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { type ApprovalContext, ApprovalManager } from '../approvals';

describe('ApprovalManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-approvals-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const manager = (): ApprovalManager =>
    new ApprovalManager(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  const context = (overrides: Partial<ApprovalContext> = {}): ApprovalContext => ({
    action: 'deploy',
    resource: 'workers',
    environment: 'production',
    severity: 'medium',
    user: 'agent',
    changes: [],
    estimatedImpact: 'low',
    requiredApprovals: 1,
    ...overrides,
  });

  it('flags critical and production changes for approval', () => {
    const m = manager();
    expect(
      m.requiresApproval(context({ severity: 'critical', environment: 'development' })).requires,
    ).toBe(true);
    expect(m.requiresApproval(context()).requires).toBe(true); // production
    expect(
      m.requiresApproval(context({ environment: 'development', severity: 'low' })).requires,
    ).toBe(false);
  });

  it('creates pending approval requests', () => {
    const m = manager();
    const id = m.requestApproval(context({ severity: 'critical', environment: 'development' }));

    expect(m.getPendingApprovals().some(r => r.id === id)).toBe(true);
  });

  it('throws when approval is not required', () => {
    const m = manager();
    expect(() =>
      m.requestApproval(context({ environment: 'development', severity: 'low' })),
    ).toThrow('does not require approval');
  });

  it('rejects unauthorized approvers', () => {
    const m = manager();
    const id = m.requestApproval(context({ severity: 'critical', environment: 'development' }));

    expect(() => m.approve(id, 'random-user')).toThrow('not authorized');
  });

  it('requires the configured number of approvers', () => {
    const m = manager();
    const id = m.requestApproval(context({ severity: 'critical', environment: 'development' }));

    m.approve(id, 'admin');
    expect(m.getPendingApprovals().some(r => r.id === id)).toBe(true); // still pending

    m.approve(id, 'lead');
    expect(m.getPendingApprovals().find(r => r.id === id)).toBeUndefined();
    expect(m.getHistory().find(r => r.id === id)?.status).toBe('approved');
  });

  it('rejects a request', () => {
    const m = manager();
    const id = m.requestApproval(context({ severity: 'critical', environment: 'development' }));

    m.reject(id, 'manager', 'not now');
    expect(m.getHistory().find(r => r.id === id)?.status).toBe('rejected');

    expect(() => m.approve(id, 'admin')).toThrow('already rejected');
  });

  it('throws for unknown requests and supports custom rules', () => {
    const m = manager();
    expect(() => m.approve('missing', 'admin')).toThrow('Approval request not found');
    expect(() => m.reject('missing', 'admin', 'no')).toThrow('Approval request not found');

    m.addRule({
      id: 'custom-rule',
      name: 'DB Guard',
      description: '',
      condition: c => c.resource === 'database',
      requiredApprovers: 1,
      approverGroups: ['dba'],
      timeoutMs: 1000,
    });
    expect(m.requiresApproval(context({ resource: 'database' })).requires).toBe(true);
  });
});
