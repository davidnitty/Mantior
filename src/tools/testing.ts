import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';
import { tracer } from '../monitoring/traces';

const execAsync = promisify(exec);

export interface TestResult {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  duration: number;
  failures: string[];
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
}

/** Runs a repo's test suite (e.g. `npm test`) and parses the summary line. */
export class TestRunner {
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  runTests(repoPath: string, command = 'npm test'): Promise<TestResult> {
    return tracer.trace(
      'tests.run',
      async span => {
        const startTime = Date.now();
        logger.info({ repoPath, command }, 'Running tests');
        tracer.setAttribute(span, 'repoPath', repoPath);

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: repoPath,
            env: { ...process.env, CI: 'true' },
          });
          const result = this.parseTestOutput(
            String(stdout),
            String(stderr),
            Date.now() - startTime,
          );
          this.audit.logAction({
            action: 'tests_completed',
            metadata: {
              repoPath,
              passed: result.passed,
              total: result.total,
              duration: result.duration,
            },
          });
          return result;
        } catch (error) {
          const execError = error as ExecError;
          const result = this.parseTestOutput(
            execError.stdout ?? '',
            execError.stderr ?? '',
            Date.now() - startTime,
          );
          this.audit.logAction({
            action: 'tests_failed',
            metadata: {
              repoPath,
              total: result.total,
              failedCount: result.failedCount,
              duration: result.duration,
            },
          });
          return result;
        }
      },
      { repoPath },
    );
  }

  private parseTestOutput(stdout: string, _stderr: string, durationMs: number): TestResult {
    const failedMatch = /(\d+)\s+failed/.exec(stdout);
    const passedMatch = /(\d+)\s+passed/.exec(stdout);
    const totalMatch = /(\d+)\s+tests/.exec(stdout);

    const failedCount = failedMatch ? Number.parseInt(failedMatch[1] ?? '0', 10) : 0;
    const passedCount = passedMatch ? Number.parseInt(passedMatch[1] ?? '0', 10) : 0;
    const total = totalMatch
      ? Number.parseInt(totalMatch[1] ?? '0', 10)
      : passedCount + failedCount;

    return {
      passed: failedCount === 0,
      total,
      passedCount,
      failedCount,
      duration: durationMs / 1000,
      failures: [],
    };
  }
}
