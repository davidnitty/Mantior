import type { ValidationStepResult } from './runner';

export interface ValidationSummary {
  passed: number;
  failed: number;
  total: number;
  allPassed: boolean;
}

/**
 * Roll up validation step results into a pass/fail summary.
 */
export function summarizeValidation(steps: ValidationStepResult[]): ValidationSummary {
  const passed = steps.filter(step => step.success).length;
  // The PR-level verdict: every REQUIRED step must have passed. Optional steps
  // may fail without failing the run.
  const allPassed = steps.length > 0 && steps.every(step => step.success || !step.required);
  return {
    passed,
    failed: steps.length - passed,
    total: steps.length,
    allPassed,
  };
}

const STEP_HEADER = '| Step | Status | Duration | Tests | Details |';
const STEP_DIVIDER = '|------|--------|----------|-------|---------|';

/**
 * Format validation results into a Markdown table for the PR body.
 */
export function formatValidationReport(steps: ValidationStepResult[]): string {
  if (steps.length === 0) {
    return '## Validation\n\n_No validation steps configured._';
  }

  const summary = summarizeValidation(steps);
  const status = summary.allPassed
    ? '✅ passed'
    : `❌ failed (${summary.passed}/${summary.total} steps passed)`;

  const rows = steps.map(step => {
    const cells = [
      mdCell(step.name),
      statusCell(step),
      formatDuration(step.durationMs),
      formatTests(step),
      detailsCell(step),
    ];
    return `| ${cells.join(' | ')} |`;
  });

  return [
    '## Validation',
    '',
    `**Status:** ${status}`,
    '',
    STEP_HEADER,
    STEP_DIVIDER,
    ...rows,
  ].join('\n');
}

function statusCell(step: ValidationStepResult): string {
  if (step.success) {
    return '✅';
  }
  return step.required ? '❌' : '⚠️';
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTests(step: ValidationStepResult): string {
  const tests = step.testResults;
  if (!tests) {
    return '—';
  }
  return `${tests.passed} passed · ${tests.failed} failed · ${tests.skipped} skipped (${tests.total} total)`;
}

function detailsCell(step: ValidationStepResult): string {
  if (step.success) {
    return '—';
  }
  if (step.error) {
    return mdCell(step.error);
  }
  return `exit code ${step.exitCode}`;
}

/** Escape Markdown table metacharacters in a cell value. */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
