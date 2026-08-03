import { describe, expect, it } from '@jest/globals';

import { fixAttempts, metricsContent, prsOpened } from './metrics';

describe('metrics', () => {
  it('increments counters and exposes Prometheus text', async () => {
    prsOpened.inc({ repo: 'acme/web', status: 'success' });
    fixAttempts.inc({ result: 'deterministic' });

    const content = await metricsContent();
    expect(content).toContain('mantior_prs_opened_total');
    expect(content).toContain('mantior_fix_attempts_total');
    expect(content).toContain('repo="acme/web"');
  });
});
