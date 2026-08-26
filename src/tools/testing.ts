import { AuditLogger } from '../audit/logger';
import { logger } from '../logger';
import { tracer } from '../monitoring/traces';
import { SandboxExecutor } from '../validation/sandbox-executor';

export interface TestResult {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  duration: number;
  failures: string[];
}

/** Runs a repo's test suite (e.g. `npm test`) and parses the summary line. */
export class TestRunner {
  private readonly audit: AuditLogger;
  private readonly sandbox: SandboxExecutor;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
    this.sandbox = new SandboxExecutor();
  }

  runTests(repoPath: string, command = 'npm test'): Promise<TestResult> {
    return tracer.trace(
      'tests.run',
      async span => {
        const startTime = Date.now();
        logger.info({ repoPath, command }, 'Running tests');
        tracer.setAttribute(span, 'repoPath', repoPath);

        // The Warden: strip secrets and blackhole network so a consumer's test
        // suite can't reach production systems or exfiltrate data.
        const outcome = await this.sandbox.execute(command, {
          cwd: repoPath,
          timeoutMs: 300_000,
          allowNetwork: false,
        });

        const result = this.parseTestOutput(
          outcome.stdout,
          outcome.exitCode === 124
            ? `${outcome.stderr}\nProcess killed: Timeout exceeded`
            : outcome.stderr,
          Date.now() - startTime,
        );

        this.audit.logAction({
          action: result.passed ? 'tests_completed' : 'tests_failed',
          metadata: {
            repoPath,
            passed: result.passed,
            total: result.total,
            exitCode: outcome.exitCode,
            duration: result.duration,
          },
        });
        return result;
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
