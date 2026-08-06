import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { type CostBudget, CostController } from '../cost-control';

describe('CostController', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-cost-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const controller = (budget?: Partial<CostBudget>): CostController =>
    new CostController(budget, new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('allows operations within budget', () => {
    const c = controller();
    expect(c.canProceed({ customerId: 'cust', workflowId: 'wf', estimatedCost: 2 }).allowed).toBe(
      true,
    );
  });

  it('blocks when the workflow budget is exceeded', () => {
    const c = controller();
    c.trackCost({ customerId: 'cust', workflowId: 'wf', cost: 4 });

    const result = c.canProceed({ customerId: 'cust', workflowId: 'wf', estimatedCost: 2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Workflow budget exceeded');
  });

  it('blocks when the customer budget is exceeded across workflows', () => {
    const c = controller({ perCustomer: 10 });
    c.trackCost({ customerId: 'cust', workflowId: 'w1', cost: 6 });
    c.trackCost({ customerId: 'cust', workflowId: 'w2', cost: 5 });

    expect(c.canProceed({ customerId: 'cust', workflowId: 'w3', estimatedCost: 1 }).allowed).toBe(
      false,
    );
  });

  it('blocks when the daily budget is exceeded', () => {
    const c = controller();
    expect(c.canProceed({ customerId: 'c', workflowId: 'w', estimatedCost: 60 }).allowed).toBe(
      false,
    );
  });

  it('blocks when the monthly budget is exceeded', () => {
    const c = controller({ perMonth: 10 });
    expect(c.canProceed({ customerId: 'c', workflowId: 'w', estimatedCost: 11 }).allowed).toBe(
      false,
    );
  });

  it('audits and logs when crossing the alert threshold but still allows', () => {
    const c = controller({ perMonth: 1, alertThreshold: 0 });

    const result = c.canProceed({ customerId: 'c', workflowId: 'w', estimatedCost: 0.2 });
    expect(result.allowed).toBe(true);

    const hits = new AuditLogger(MantiorDatabase.getInstance(dbPath)).search({
      action: 'cost_alert_threshold',
    });
    expect(hits).toHaveLength(1);
  });

  it('audits tracked costs', () => {
    const c = controller();
    c.trackCost({ customerId: 'a', workflowId: 'b', cost: 1.5 });

    const hits = new AuditLogger(MantiorDatabase.getInstance(dbPath)).search({
      action: 'cost_tracked',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].metadata.cost).toBe(1.5);
  });
});
