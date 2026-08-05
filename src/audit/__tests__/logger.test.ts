import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { MantiorDatabase } from '../../state/database';
import { AuditLogger } from '../logger';

describe('AuditLogger', () => {
  let testDir: string;
  let dbPath: string;
  let audit: AuditLogger;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-audit-'));
    dbPath = join(testDir, 'test.db');
    audit = new AuditLogger(MantiorDatabase.getInstance(dbPath));
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('logs actions and searches by filter', () => {
    audit.logAction({
      action: 'workflow_started',
      userId: 'alice',
      metadata: { workflowId: 'wf_1' },
    });
    audit.logAction({ action: 'step_completed', metadata: { workflowId: 'wf_1', stepId: 's1' } });

    const byAction = audit.search({ action: 'workflow_started' });
    expect(byAction).toHaveLength(1);
    expect(byAction[0]?.userId).toBe('alice');

    const byUser = audit.search({ userId: 'alice' });
    expect(byUser).toHaveLength(1);
  });

  it('retrieves the full audit trail for a workflow via metadata', () => {
    audit.logAction({ action: 'workflow_started', metadata: { workflowId: 'wf_42' } });
    audit.logAction({ action: 'step_completed', metadata: { workflowId: 'wf_42', stepId: 's1' } });
    audit.logAction({
      action: 'step_completed',
      metadata: { workflowId: 'wf_other', stepId: 's1' },
    });

    const trail = audit.getWorkflowAudit('wf_42');
    expect(trail).toHaveLength(2);
    expect(trail.every(entry => entry.metadata.workflowId === 'wf_42')).toBe(true);
  });

  it('exports JSON and CSV', () => {
    audit.logAction({ action: 'connector_success', metadata: { connector: 'rest' } });

    const json = audit.export({ format: 'json' });
    expect(JSON.parse(json).length).toBeGreaterThan(0);

    const csv = audit.export({ format: 'csv' });
    expect(csv.startsWith('timestamp,action,userId,metadata')).toBe(true);
    expect(csv).toContain('connector_success');
  });
});
