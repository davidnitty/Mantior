import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MantiorDatabase } from '../database';

describe('MantiorDatabase', () => {
  let testDir: string;
  let dbPath: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-db-'));
    dbPath = join(testDir, 'test.db');
  });

  afterAll(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('inserts and reads scan records', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    const scanId = db.insertScan({
      timestamp: '2026-01-01T00:00:00.000Z',
      duration: 1.25,
      changes_detected: 3,
      consumers_scanned: 2,
      prs_opened: 1,
      errors_count: 0,
      status: 'success',
      config_hash: 'abcd1234',
    });

    const latest = db.getLatestScan();
    expect(latest).toBeDefined();
    expect(latest?.changes_detected).toBe(3);
    expect(latest?.status).toBe('success');

    db.insertConsumer({
      scan_id: scanId,
      repo: 'acme/web',
      branch: 'main',
      language: 'typescript',
      call_sites_found: 2,
      pr_opened: true,
      pr_url: 'https://github.com/acme/web/pull/1',
    });

    const consumers = db.getConsumersForScan(scanId);
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.repo).toBe('acme/web');
  });

  it('computes the status summary across runs', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    db.insertScan({
      timestamp: '2026-01-02T00:00:00.000Z',
      duration: 0.5,
      changes_detected: 1,
      consumers_scanned: 1,
      prs_opened: 2,
      errors_count: 1,
      status: 'partial',
      config_hash: 'efgh5678',
    });

    const summary = db.getStatusSummary();
    expect(summary.totalScans).toBeGreaterThanOrEqual(2);
    expect(summary.totalChangesDetected).toBeGreaterThanOrEqual(4);
    expect(summary.totalPRsOpened).toBeGreaterThanOrEqual(3);
  });

  it('returns recent activity merged across kinds', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    const activity = db.getRecentActivity(10);
    expect(activity.length).toBeGreaterThan(0);
    expect(['scan', 'pr', 'error']).toContain(activity[0]?.kind);
  });

  it('stores and reads autonomy decisions', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    const scanId = db.insertScan({
      timestamp: '2026-01-03T00:00:00.000Z',
      duration: 0.1,
      changes_detected: 1,
      consumers_scanned: 0,
      prs_opened: 0,
      errors_count: 0,
      status: 'success',
      config_hash: 'abcd',
    });
    db.insertAutonomyLog({
      timestamp: '2026-01-03T00:00:00.100Z',
      scan_id: scanId,
      change_type: 'property_renamed',
      change_message: 'amount → amount_cents',
      requested_level: 4,
      effective_level: 4,
      action_taken: 'pr_with_approval',
      confidence_score: 90,
      requires_approval: true,
    });

    const logs = db.getRecentAutonomyLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action_taken).toBe('pr_with_approval');
  });

  it('persists key/value settings', () => {
    const db = MantiorDatabase.getInstance(dbPath);
    expect(db.getSetting('autonomy_level')).toBeUndefined();

    db.setSetting('autonomy_level', '5');
    expect(db.getSetting('autonomy_level')).toBe('5');

    db.setSetting('autonomy_level', '2');
    expect(db.getSetting('autonomy_level')).toBe('2');
  });
});
