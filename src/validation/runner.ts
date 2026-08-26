import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ValidationStepConfig } from '../config/loader';
import { logger } from '../logger';

import { interpolateCommand } from './package-manager';
import { parseTestOutput, type TestResults } from './parsers';
import { SandboxExecutor } from './sandbox-executor';

export interface ValidationStepResult {
  name: string;
  success: boolean;
  exitCode: number;
  durationMs: number;
  required: boolean;
  testResults?: TestResults | null;
  error?: string;
}

const ERROR_TAIL = 500;

/**
 * Executes the consumer's validation steps inside the Warden sandbox and
 * pipes test steps through the configured parser. A failing REQUIRED step
 * aborts the remaining pipeline; optional steps may fail without stopping it.
 */
export class ValidationRunner {
  private readonly sandbox: SandboxExecutor;

  constructor() {
    this.sandbox = new SandboxExecutor();
  }

  async run(
    repoPath: string,
    steps: ValidationStepConfig[],
    packageManager: string,
  ): Promise<ValidationStepResult[]> {
    const results: ValidationStepResult[] = [];

    for (const step of steps) {
      // Skip steps whose npm script doesn't exist in the consumer's
      // package.json (e.g. no "type-check" script) instead of failing them.
      if (await this.shouldSkipStep(repoPath, step)) {
        logger.info({ step: step.name }, 'Skipping validation step (script not found)');
        continue;
      }

      const command = interpolateCommand(step.command, packageManager);
      const startTime = Date.now();
      logger.info({ step: step.name, command }, 'Running validation step');

      try {
        const { stdout, stderr, exitCode } = await this.sandbox.execute(command, {
          cwd: repoPath,
          timeoutMs: step.timeout * 1000,
          allowNetwork: step.allow_network,
        });

        const durationMs = Date.now() - startTime;
        const success = exitCode === 0;

        const testResults = step.parser ? parseTestOutput(step.parser, stdout, stderr) : null;

        results.push({
          name: step.name,
          success,
          exitCode,
          durationMs,
          required: step.required,
          testResults,
          error: success ? undefined : (stderr || stdout).slice(-ERROR_TAIL),
        });

        if (!success && step.required) {
          break;
        }
      } catch (error) {
        results.push({
          name: step.name,
          success: false,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          required: step.required,
          error: error instanceof Error ? error.message : String(error),
        });
        if (step.required) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * True when a step invokes an npm script that the consumer repo does not
   * define (`{pm} run <script>` or `{pm} test`). Non-package-manager commands
   * are never skipped. If package.json can't be read, npm-script steps are
   * skipped rather than failed.
   */
  async shouldSkipStep(repoPath: string, step: ValidationStepConfig): Promise<boolean> {
    const scriptMatch = /^\{pm\}\s+(?:run\s+(\S+)|test)\b/.exec(step.command);
    if (!scriptMatch) {
      return false;
    }
    const scriptName = scriptMatch[1] ?? 'test';

    try {
      const raw = await readFile(join(repoPath, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      return typeof pkg.scripts?.[scriptName] !== 'string';
    } catch {
      return true;
    }
  }
}
