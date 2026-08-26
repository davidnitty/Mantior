import { describe, expect, it } from '@jest/globals';

import { parseTestOutput } from '../parsers';

describe('parseTestOutput', () => {
  it('parses Jest pass/fail totals', () => {
    const output = 'Tests:       1 failed, 47 passed, 48 total\nTime:        3.2 s';
    const result = parseTestOutput('jest', output, '');

    expect(result).not.toBeNull();
    expect(result?.framework).toBe('Jest/Vitest');
    expect(result?.failed).toBe(1);
    expect(result?.passed).toBe(47);
    expect(result?.total).toBe(48);
    expect(result?.durationSec).toBeCloseTo(3.2);
  });

  it('parses Jest skipped counts in the real order (failed, skipped, passed, total)', () => {
    const output = 'Tests:       1 failed, 2 skipped, 6 passed, 9 total';
    const result = parseTestOutput('jest', output, '');

    expect(result?.failed).toBe(1);
    expect(result?.skipped).toBe(2);
    expect(result?.passed).toBe(6);
    expect(result?.total).toBe(9);
  });

  it('routes vitest through the Jest parser', () => {
    const output = 'Tests  1 failed | 47 passed (48)\nTime: 1.5s';
    const result = parseTestOutput('vitest', output, '');

    expect(result?.framework).toBe('Jest/Vitest');
    expect(result?.passed).toBe(47);
  });

  it('parses Pytest pass totals', () => {
    const output = '========================= 48 passed in 2.34s =========================';
    const result = parseTestOutput('pytest', output, '');

    expect(result?.framework).toBe('Pytest');
    expect(result?.passed).toBe(48);
    expect(result?.failed).toBe(0);
    expect(result?.total).toBe(48);
    expect(result?.durationSec).toBeCloseTo(2.34);
  });

  it('parses Pytest with failures and warnings', () => {
    const output =
      '=================== 1 failed, 47 passed, 1 warning in 3.10s ===================';
    const result = parseTestOutput('pytest', output, '');

    expect(result?.failed).toBe(1);
    expect(result?.passed).toBe(47);
    expect(result?.total).toBe(48);
    expect(result?.durationSec).toBeCloseTo(3.1);
  });

  it('parses Go test package summaries', () => {
    const output = [
      'ok  \tgithub.com/acme/app\t1.234s',
      'FAIL\tgithub.com/acme/bad\t0.500s',
      'ok  \tgithub.com/acme/util\t0.100s',
    ].join('\n');
    const result = parseTestOutput('gotest', output, '');

    expect(result?.framework).toBe('Go Test');
    expect(result?.passed).toBe(2);
    expect(result?.failed).toBe(1);
    expect(result?.total).toBe(3);
  });

  it('returns null for an unknown framework', () => {
    expect(parseTestOutput('mocha', '1 passing', '')).toBeNull();
  });

  it('returns zero counts when no summary line is present', () => {
    const result = parseTestOutput('jest', 'no summary here', '');
    expect(result).not.toBeNull();
    expect(result?.total).toBe(0);
    expect(result?.passed).toBe(0);
    expect(result?.failed).toBe(0);
  });
});
