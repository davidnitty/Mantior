import { describe, expect, it } from '@jest/globals';

import type { BreakingChange } from '../../diff/engine';
import type { ValidationStepResult } from '../../validation/runner';
import { generatePRBody } from '../pr-body-generator';

describe('generatePRBody', () => {
  const rename: BreakingChange = {
    type: 'property_renamed',
    severity: 'breaking',
    property: 'amount',
    newProperty: 'amount_cents',
    message: 'Property "amount" renamed to "amount_cents".',
    confidence: 100,
  };
  const removal: BreakingChange = {
    type: 'endpoint_removed',
    severity: 'breaking',
    path: '/v1/charges',
    message: 'Endpoint "/v1/charges" was removed.',
    confidence: 100,
  };

  const passing = (overrides: Partial<ValidationStepResult>): ValidationStepResult => ({
    name: 'Run Tests',
    success: true,
    exitCode: 0,
    durationMs: 1234,
    required: true,
    ...overrides,
  });

  it('renders the header, breaking changes and fix count', () => {
    const body = generatePRBody([rename, removal], ['fix-a', 'fix-b'], []);

    expect(body).toContain('# 🤖 Mantior API Migration');
    expect(body).toContain('## ⚠️ Breaking Changes Detected');
    expect(body).toContain('**property_renamed**: `amount` → `amount_cents`');
    expect(body).toContain('**endpoint_removed**: Endpoint "/v1/charges" was removed.');
    expect(body).toContain('**2** automated fixes');
  });

  it('renders passing validation steps and a SAFE TO MERGE verdict', () => {
    const body = generatePRBody(
      [rename],
      [],
      [passing({ name: 'Type Check' }), passing({ name: 'Run Tests' })],
    );

    expect(body).toContain('| **Type Check** | ✅ Pass | Completed |');
    expect(body).toContain('### ✅ Overall Verdict: SAFE TO MERGE');
    expect(body).not.toContain('View Error Logs');
  });

  it('renders test counts and a MANUAL REVIEW verdict for a required failure', () => {
    const body = generatePRBody(
      [rename],
      [],
      [
        passing({
          name: 'Run Tests',
          success: false,
          exitCode: 1,
          required: true,
          error: 'build error',
        }),
      ],
    );

    expect(body).toContain('| **Run Tests** | ❌ Fail | `Exit code: 1` |');
    expect(body).toContain('### ⚠️ Overall Verdict: MANUAL REVIEW REQUIRED');
    expect(body).toContain('<summary>📋 View Error Logs</summary>');
    expect(body).toContain('build error');
  });

  it('shows parsed test totals in the Details column', () => {
    const body = generatePRBody(
      [rename],
      [],
      [
        passing({
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
      ],
    );

    expect(body).toContain('**1 failed**, 47 passed (out of 48)');
  });

  it('marks optional failures as warnings and still says SAFE TO MERGE', () => {
    const body = generatePRBody(
      [rename],
      [],
      [
        passing({ name: 'Install', success: false, required: false, error: 'registry down' }),
        passing({ name: 'Run Tests' }),
      ],
    );

    expect(body).toContain('| **Install** | ⚠️ Warn |');
    expect(body).toContain('### ✅ Overall Verdict: SAFE TO MERGE');
  });

  it('escapes pipes in table cells but keeps code-block errors verbatim', () => {
    const body = generatePRBody(
      [rename],
      [],
      [passing({ name: 'a|b', success: false, error: 'line1\nline2|tail' })],
    );

    expect(body).toContain('a\\|b'); // step name escaped in the table
    expect(body).toContain('line2|tail'); // error is verbatim inside the fenced block
  });

  it('renders the test fixture remediation section when fixtures are provided', () => {
    const body = generatePRBody(
      [rename],
      [],
      [],
      [
        { file: 'src/users/__tests__/getUser.test.ts', mocksUpdated: 2, assertionsUpdated: 4 },
        { file: 'src/users/__tests__/mocks.ts', mocksUpdated: 1, assertionsUpdated: 0 },
      ],
    );

    expect(body).toContain('## 🧪 Test Fixture Remediation');
    expect(body).toContain('| `src/users/__tests__/getUser.test.ts` | 2 | 4 |');
    expect(body).toContain('| `src/users/__tests__/mocks.ts` | 1 | 0 |');
    expect(body).toContain('**Total:** 3 mocks and 4 assertions automatically updated');
  });

  it('omits the test fixture section when no fixtures were updated', () => {
    const body = generatePRBody([rename], [], []);
    expect(body).not.toContain('Test Fixture Remediation');
  });

  it('omits the validation section and verdict when no validation ran', () => {
    const body = generatePRBody([rename], ['fix-a'], []);
    expect(body).not.toContain('Validation Sandbox Results');
    expect(body).not.toContain('SAFE TO MERGE');
    expect(body).not.toContain('MANUAL REVIEW REQUIRED');
  });

  it('ends with the footer', () => {
    const body = generatePRBody([], [], []);
    expect(body).toContain(
      '*Generated by [Mantior](https://github.com/davidnitty/Mantior) • Autonomy Level 4*',
    );
  });
});
