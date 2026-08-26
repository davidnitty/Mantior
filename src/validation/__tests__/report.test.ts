import { describe, expect, it } from '@jest/globals';

import { formatValidationReport, summarizeValidation } from '../report';
import type { ValidationStepResult } from '../runner';

describe('validation report', () => {
  const step = (overrides: Partial<ValidationStepResult>): ValidationStepResult => ({
    name: 'Run Tests',
    success: true,
    exitCode: 0,
    durationMs: 1234,
    required: true,
    ...overrides,
  });

  it('summarizes pass/fail counts', () => {
    const summary = summarizeValidation([
      step({ name: 'Install', success: true, required: false }),
      step({ name: 'Build', success: false }),
      step({ name: 'Tests', success: true }),
    ]);

    expect(summary).toEqual({ passed: 2, failed: 1, total: 3, allPassed: false });
  });

  it('renders an all-passing table', () => {
    const report = formatValidationReport([
      step({ name: 'Install', durationMs: 45_000 }),
      step({ name: 'Run Tests', durationMs: 1_200 }),
    ]);

    expect(report).toContain('**Status:** ✅ passed');
    expect(report).toContain('| Install | ✅ | 45.0s | — | — |');
    expect(report).toContain('| Step | Status | Duration | Tests | Details |');
  });

  it('renders failures with the error detail and a ❌ summary', () => {
    const report = formatValidationReport([
      step({ name: 'Build', success: false, exitCode: 1, error: 'build error' }),
      step({ name: 'Run Tests', success: true }),
    ]);

    expect(report).toContain('**Status:** ❌ failed (1/2 steps passed)');
    expect(report).toContain('| Build | ❌ |');
    expect(report).toContain('build error');
  });

  it('marks optional failures as ⚠️', () => {
    const report = formatValidationReport([
      step({ name: 'Install', success: false, required: false, error: 'registry down' }),
      step({ name: 'Run Tests', success: true }),
    ]);

    expect(report).toContain('| Install | ⚠️ |');
    expect(report).toContain('**Status:** ✅ passed');
  });

  it('renders parsed test counts in the Tests column', () => {
    const report = formatValidationReport([
      step({
        name: 'Run Tests',
        testResults: {
          framework: 'Jest/Vitest',
          total: 48,
          passed: 47,
          failed: 1,
          skipped: 0,
          durationSec: 3.2,
          rawOutput: '',
        },
      }),
    ]);

    expect(report).toContain('47 passed · 1 failed · 0 skipped (48 total)');
  });

  it('escapes pipes and newlines in cells', () => {
    const report = formatValidationReport([
      step({ name: 'a|b', success: false, error: 'line1\nline2|tail' }),
    ]);

    expect(report).toContain('a\\|b');
    expect(report).toContain('line1 line2\\|tail');
  });

  it('reports no steps configured', () => {
    expect(formatValidationReport([])).toContain('No validation steps configured');
  });
});
