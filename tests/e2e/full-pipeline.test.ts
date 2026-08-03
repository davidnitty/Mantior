import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../../src/orchestrator';

/**
 * E2E: config → diff (local fixture specs) → consumer clone → fix → PR.
 * Manual only (it.skip): requires a real consumer repo + GITHUB_TOKEN.
 * Run locally with: npx jest --runInBand --testPathPattern=e2e --no-coverage
 */
describe.skip('E2E: Full Pipeline', () => {
  it('runs end-to-end from config to PR', async () => {
    const testDir = join(tmpdir(), 'mantior-e2e');
    mkdirSync(testDir, { recursive: true });

    const configPath = join(testDir, 'mantior.yaml');
    const writeSpec = (name: string, content: string): string => {
      const path = join(testDir, name);
      writeFileSync(path, content);
      return path;
    };
    const v1 = writeSpec(
      'spec-v1.yaml',
      'openapi: 3.0.0\npaths:\n  /test:\n    get:\n      responses:\n        200:\n          schema:\n            properties:\n              old: { type: string }',
    );
    const v2 = writeSpec(
      'spec-v2.yaml',
      'openapi: 3.0.0\npaths:\n  /test:\n    get:\n      responses:\n        200:\n          schema:\n            properties:\n              new: { type: string }',
    );

    writeFileSync(
      configPath,
      [
        'api:',
        '  name: "E2E Test API"',
        `  spec: ${v2}`,
        `  reference_url: ${v1}`,
        'consumers:',
        '  - repo: "https://github.com/mantior-test/consumer-repo.git"',
        '    branch: "main"',
        '    language: "typescript"',
        'security:',
        '  github_token: ${GITHUB_TOKEN}',
        'rules:',
        '  auto_pr: true',
        '  pr_labels: ["mantior-test"]',
        '',
      ].join('\n'),
    );

    try {
      const orchestrator = new Orchestrator();
      const result = await orchestrator.run(configPath, { dryRun: true });
      expect(result.changesDetected).toBeGreaterThan(0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 120_000);
});
