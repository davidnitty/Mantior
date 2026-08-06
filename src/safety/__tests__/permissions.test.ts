import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { PermissionManager } from '../permissions';

describe('PermissionManager', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-perms-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const manager = (): PermissionManager =>
    new PermissionManager(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('loads the default permission set', () => {
    const names = manager()
      .list()
      .map(p => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Developer Read-Only',
        'Operator Write',
        'Admin Full Access',
        'System Automated',
        'Database Admin',
      ]),
    );
  });

  it('allows developers to read in non-production environments', () => {
    const pm = manager();
    expect(pm.check('developer', 'read', 'database', 'development')).toEqual({ allowed: true });
    expect(pm.check('developer', 'list', 'workers', 'staging')).toEqual({ allowed: true });
  });

  it('denies developers write access', () => {
    const pm = manager();
    expect(pm.check('developer', 'write', 'workers', 'development').allowed).toBe(false);
    expect(pm.check('developer', 'restart', 'workers', 'staging').allowed).toBe(false);
  });

  it('respects the operator resource scope and environments', () => {
    const pm = manager();
    expect(pm.check('operator', 'restart', 'workers', 'development').allowed).toBe(true);
    expect(pm.check('operator', 'restart', 'database', 'development').allowed).toBe(false);
    expect(pm.check('operator', 'restart', 'workers', 'production').allowed).toBe(false);
  });

  it('gives admins full access including production', () => {
    const pm = manager();
    expect(pm.check('admin', 'migration', 'database', 'production').allowed).toBe(true);
  });

  it('reports missing permissions for unknown users', () => {
    const pm = manager();
    const result = pm.check('nobody', 'restart', 'database', 'production');
    expect(result.allowed).toBe(false);
    expect(result.missingPermissions).toEqual(['restart:database']);
  });

  it('grants and revokes permissions', () => {
    const pm = manager();
    const id = pm.grant({
      name: 'Temp Access',
      description: 'Scoped temp access',
      grantedTo: 'bob',
      scope: {
        resources: ['cache'],
        actions: ['read'],
        dataTypes: ['metrics'],
        environments: ['development'],
      },
    });

    expect(pm.getUserPermissions('bob')).toHaveLength(1);
    expect(pm.check('bob', 'read', 'cache', 'development').allowed).toBe(true);

    pm.revoke(id);
    expect(pm.getUserPermissions('bob')).toHaveLength(0);
  });

  it('throws when revoking an unknown permission', () => {
    expect(() => manager().revoke('perm_missing')).toThrow('Permission not found');
  });

  it('enforces time restrictions', () => {
    const pm = manager();

    // Window that can never include "now" → always denied.
    const deniedId = pm.grant({
      name: 'Night-Shift',
      description: '',
      grantedTo: 'night_worker',
      scope: {
        resources: ['db'],
        actions: ['read'],
        dataTypes: ['*'],
        environments: ['production'],
        timeRestriction: { start: '99:00', end: '99:00', timezone: 'UTC' },
      },
    });
    const denied = pm.check('night_worker', 'read', 'db', 'production');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('time window');

    // Window that always includes "now" → allowed.
    pm.grant({
      name: 'All-Day',
      description: '',
      grantedTo: 'day_worker',
      scope: {
        resources: ['db'],
        actions: ['read'],
        dataTypes: ['*'],
        environments: ['production'],
        timeRestriction: { start: '00:00', end: '23:59', timezone: 'UTC' },
      },
    });
    expect(pm.check('day_worker', 'read', 'db', 'production').allowed).toBe(true);

    pm.revoke(deniedId);
  });

  it('ignores expired permissions', () => {
    const pm = manager();
    pm.grant({
      name: 'Expired',
      description: '',
      grantedTo: 'temp_user',
      expiresAt: new Date(Date.now() - 1000),
      scope: {
        resources: ['*'],
        actions: ['read'],
        dataTypes: ['*'],
        environments: ['development', 'staging', 'production'],
      },
    });

    expect(pm.check('temp_user', 'read', 'anything', 'development').allowed).toBe(false);
  });
});
