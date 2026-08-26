import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { ValidationStepConfig } from '../../config/loader';
import { ValidationRunner } from '../runner';

describe('ValidationRunner', () => {
  let testDir: string;
  let runner: ValidationRunner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-runner-'));
    runner = new ValidationRunner();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const step = (overrides: Partial<ValidationStepConfig>): ValidationStepConfig => ({
    name: 'step',
    command: 'node -e "console.log(\'ok\')"',
    allow_network: false,
    timeout: 30,
    required: true,
    ...overrides,
  });

  it('runs a passing step', async () => {
    const results = await runner.run(testDir, [step({ name: 'Run Tests' })], 'npm');

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.exitCode).toBe(0);
  });

  it('marks a required failing step and aborts', async () => {
    const results = await runner.run(
      testDir,
      [
        step({
          command: 'node -e "process.stderr.write(\'build error\'); process.exit(1)"',
          name: 'Build',
        }),
        step({ name: 'Never Runs' }),
      ],
      'npm',
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.exitCode).toBe(1);
    expect(results[0]?.error).toContain('build error');
  });

  it('does not abort on a failing optional step', async () => {
    const results = await runner.run(
      testDir,
      [
        step({ name: 'Install', required: false, command: 'node -e "process.exit(1)"' }),
        step({ name: 'Tests' }),
      ],
      'npm',
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(false);
    expect(results[1]?.success).toBe(true);
  });

  it('routes a test step through its parser', async () => {
    const results = await runner.run(
      testDir,
      [
        step({
          name: 'Run Tests',
          command: 'node -e "console.log(\'Tests:       1 failed, 47 passed, 48 total\')"',
          parser: 'jest',
        }),
      ],
      'npm',
    );

    expect(results[0]?.testResults).not.toBeNull();
    expect(results[0]?.testResults?.framework).toBe('Jest/Vitest');
    expect(results[0]?.testResults?.passed).toBe(47);
    expect(results[0]?.testResults?.failed).toBe(1);
  });

  it('interpolates {pm} with the given package manager', async () => {
    const results = await runner.run(
      testDir,
      [step({ name: 'Version', command: '{pm} -v' })],
      'npm',
    );

    // Success only if "{pm}" was interpolated into a real `npm -v` command.
    expect(results[0]?.success).toBe(true);
  });

  it('reports a timed-out step via exit code 124', async () => {
    // Run against process.cwd() (not the temp dir) so the killed child's cwd
    // handle doesn't make afterEach's rmdir fail with EBUSY on Windows.
    const results = await runner.run(
      process.cwd(),
      [step({ name: 'Hang', command: 'node -e "setTimeout(function(){}, 5000)"', timeout: 1 })],
      'npm',
    );

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.exitCode).toBe(124);
    expect(results[0]?.error).toContain('Timeout exceeded');
  });
});
