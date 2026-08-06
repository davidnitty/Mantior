import { describe, expect, it } from '@jest/globals';

import { register as mantiorRegister } from '../../monitoring/metrics';
import { MetricsCollector } from '../metrics';

describe('MetricsCollector', () => {
  const window = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-02T00:00:00Z') };

  it('returns neutral product metrics when no data is wired', () => {
    const metrics = new MetricsCollector().collectProductMetrics(window.start, window.end);

    expect(metrics.incidentsDetected).toBe(0);
    expect(metrics.meanTimeToDetect).toBe(0);
    expect(metrics.meanTimeToResolve).toBe(0);
    expect(metrics.correctDiagnosisRate).toBe(0);
    expect(metrics.successfulRemediationRate).toBe(0);
    expect(metrics.rollbackRate).toBe(0);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.humanApprovalRate).toBe(0);
    expect(metrics.customerRetention).toBe(95);
    expect(metrics.revenuePerAccount).toBe(5000);
  });

  it('returns neutral agent metrics when no tasks exist', () => {
    const metrics = new MetricsCollector().collectAgentMetrics(window.start, window.end);

    expect(metrics.averageResponseTime).toBe(0);
    expect(metrics.throughput).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.confidenceScore).toBe(0);
    expect(metrics.hallucinationRate).toBe(0);
    expect(metrics.contextAccuracy).toBe(0);
    expect(metrics.costPerTask).toBe(0);
    expect(metrics.toolUseCount).toBe(0);
  });

  it('publishes and reuses named gauges on the shared registry', async () => {
    const collector = new MetricsCollector();

    collector.recordMetric('safety_gauge_unlabeled', 42);
    const unlabeled = mantiorRegister.getSingleMetric('mantior_safety_gauge_unlabeled') as
      { get(): Promise<{ values: Array<{ value: number }> }> } | undefined;
    expect(unlabeled).toBeDefined();
    const unlabeledValue = await unlabeled?.get();
    expect(unlabeledValue?.values[0].value).toBe(42);

    collector.recordMetric('safety_gauge_labeled', 7, { env: 'prod' });
    collector.recordMetric('safety_gauge_labeled', 8, { env: 'prod' });
    const labeled = mantiorRegister.getSingleMetric('mantior_safety_gauge_labeled') as
      | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
      | undefined;
    expect(labeled).toBeDefined();
    const labeledValue = await labeled?.get();
    expect(labeledValue?.values[0].value).toBe(8);
  });
});
