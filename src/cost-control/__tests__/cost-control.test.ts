import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { CostController } from '../../cost-control';
import { MantiorDatabase } from '../../state/database';

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

  const fresh = (config: Partial<CostControllerConfig> = {}): CostController =>
    new CostController(config, MantiorDatabase.getInstance(dbPath));

  it('allows calls under the caps', () => {
    const controller = fresh({ maxCostPerDay: 10, maxCostPerMonth: 50, maxCostPerScan: 5 });
    controller.beginScan();
    expect(controller.canProceed()).toEqual({ allowed: true });
  });

  it('hard-stops after the daily cap', () => {
    const controller = fresh({ maxCostPerDay: 1, maxCostPerMonth: 100, maxCostPerScan: 100 });
    controller.trackLLMCall('gpt-4o-mini', { input: 1000, output: 200 }, 1.0);

    const decision = controller.canProceed();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Daily');
  });

  it('hard-stops within a single scan run', () => {
    const controller = fresh({ maxCostPerDay: 100, maxCostPerMonth: 100, maxCostPerScan: 2 });
    controller.beginScan();
    controller.trackLLMCall('gpt-4o', { input: 1000, output: 200 }, 1.5);
    expect(controller.canProceed().allowed).toBe(true);

    controller.trackLLMCall('gpt-4o', { input: 1000, output: 200 }, 1.0);
    expect(controller.canProceed().allowed).toBe(false);
  });

  it('respects the monthly cap', () => {
    const controller = fresh({ maxCostPerDay: 1000, maxCostPerMonth: 2, maxCostPerScan: 1000 });
    controller.trackLLMCall('gpt-4o', { input: 1000, output: 200 }, 2.5);

    expect(controller.canProceed().allowed).toBe(false);
  });

  it('persists daily totals and reports remaining budget', () => {
    const controller = fresh({ maxCostPerDay: 5, maxCostPerMonth: 100, maxCostPerScan: 100 });
    controller.trackLLMCall('gpt-4o-mini', { input: 500, output: 100 }, 0.5);

    expect(controller.getTodayCost()).toBeGreaterThanOrEqual(0.5);
    expect(controller.getRemainingBudget()).toBeLessThanOrEqual(4.5);
  });

  it('resets the scan budget between runs', () => {
    const controller = fresh({ maxCostPerDay: 100, maxCostPerMonth: 100, maxCostPerScan: 2 });
    controller.beginScan();
    controller.trackLLMCall('gpt-4o', { input: 1000, output: 200 }, 2.0);
    expect(controller.canProceed().allowed).toBe(false);

    controller.beginScan();
    expect(controller.canProceed().allowed).toBe(true);
  });
});

// Type helper so test configs stay in sync with the production config shape.
type CostControllerConfig = ConstructorParameters<typeof CostController>[0];
