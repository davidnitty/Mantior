import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MantiorConfig } from '../../../config/loader';
import { PROpener } from '../../pr-opener';

// Integration tests hit the real GitHub API — run only with a REAL token
// (the jest.setup 'test-token' placeholder must not trigger network calls).
const token = process.env.GITHUB_TOKEN ?? '';
const hasRealToken = token.startsWith('ghp_') || token.startsWith('github_pat_');
const describeIntegration = hasRealToken ? describe : describe.skip;

describeIntegration('PROpener Integration', () => {
  let testDir: string;
  let opener: PROpener;

  const config: MantiorConfig = {
    api: { name: 'Test API', spec: 'spec.yaml', reference_url: 'http://example.com' },
    consumers: [],
    security: { github_token: token },
    rules: { auto_pr: true, pr_labels: [] },
    mappings: [],
    notifications: {},
  };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-test-'));
    opener = new PROpener(config);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a PR on a test repository', async () => {
    const result = await opener.createPR(
      testDir,
      'https://github.com/mantior-test/test-repo.git',
      'main',
      { 'README.md': '# Updated by Mantior' },
      [
        {
          type: 'property_removed',
          severity: 'breaking',
          property: 'amount',
          message: 'amount removed',
          confidence: 100,
        },
      ],
      { draft: true },
    );

    expect(result.prUrl).toContain('github.com');
    expect(result.prNumber).toBeGreaterThan(0);
  }, 60_000);
});
