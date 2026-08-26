export interface TestResults {
  framework: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationSec: number;
  /** Truncated for the PR body. */
  rawOutput: string;
}

const RAW_OUTPUT_TAIL = 1000;

/**
 * Factory to route output to the correct parser based on mantior.yaml config.
 */
export function parseTestOutput(
  framework: string,
  stdout: string,
  stderr: string,
): TestResults | null {
  const combined = `${stdout}\n${stderr}`;

  switch (framework.toLowerCase()) {
    case 'jest':
    case 'vitest':
      return parseJestOutput(combined);
    case 'pytest':
      return parsePytestOutput(combined);
    case 'gotest':
      return parseGoTestOutput(combined);
    default:
      return null; // Unknown framework — caller reports raw pass/fail.
  }
}

/**
 * Jest/Vitest summary line:
 *   "Tests:       1 failed, 2 skipped, 47 passed, 50 total"
 * Counts may appear in any order or be omitted, so parse each token
 * independently rather than relying on positional capture groups.
 */
function parseJestOutput(output: string): TestResults {
  const jestSummary = /Tests:\s+([^\n]+)/.exec(output);
  const vitestSummary = /Tests\s+([^\n]+)/.exec(output);
  const summary = jestSummary?.[1] ?? vitestSummary?.[1] ?? '';
  const counts = parseCounts(summary);

  // Vitest reports the total as "(N)" rather than "N total".
  if (counts.total === 0) {
    const parenTotal = /\((\d+)\)/.exec(summary);
    if (parenTotal) {
      counts.total = Number.parseInt(parenTotal[1] ?? '0', 10);
    }
  }

  const timeMatch = /Time:\s+([\d.]+)\s*s/.exec(output);

  return {
    framework: 'Jest/Vitest',
    ...counts,
    durationSec: timeMatch ? Number.parseFloat(timeMatch[1] ?? '0') : 0,
    rawOutput: output.slice(-RAW_OUTPUT_TAIL),
  };
}

/**
 * Pytest summary line:
 *   "48 passed in 2.34s"
 *   "1 failed, 47 passed, 1 warning in 3.10s"
 * Pytest has no "total" token — total is the sum of failed/passed/skipped.
 */
function parsePytestOutput(output: string): TestResults {
  const summary =
    output.split('\n').find(line => /=\s*\d+/.test(line) && /\d+s\s*=/.test(line)) ?? '';
  const timeMatch = /in\s+([\d.]+)s/.exec(summary);
  const { failed, passed, skipped } = parseCounts(summary);

  return {
    framework: 'Pytest',
    failed,
    passed,
    skipped,
    total: failed + passed + skipped,
    durationSec: timeMatch ? Number.parseFloat(timeMatch[1] ?? '0') : 0,
    rawOutput: output.slice(-RAW_OUTPUT_TAIL),
  };
}

/**
 * Go test package summary lines:
 *   "ok  \tgithub.com/acme/app\t1.234s"
 *   "FAIL\tgithub.com/acme/bad\t0.500s"
 */
function parseGoTestOutput(output: string): TestResults {
  let passed = 0;
  let failed = 0;
  let durationSec = 0;

  for (const line of output.split('\n')) {
    if (line.startsWith('ok')) {
      passed++;
      const timeMatch = /([\d.]+)s/.exec(line);
      if (timeMatch) {
        durationSec += Number.parseFloat(timeMatch[1] ?? '0');
      }
    } else if (line.startsWith('FAIL')) {
      failed++;
    }
  }

  return {
    framework: 'Go Test',
    passed,
    failed,
    skipped: 0,
    total: passed + failed,
    durationSec,
    rawOutput: output.slice(-RAW_OUTPUT_TAIL),
  };
}

function parseCounts(summary: string): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const pick = (label: string): number => {
    const match = new RegExp(`(\\d+)\\s+${label}`).exec(summary);
    return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
  };

  return {
    total: pick('total'),
    passed: pick('passed'),
    failed: pick('failed'),
    skipped: pick('skipped'),
  };
}
