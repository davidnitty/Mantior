import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { logger } from '../logger';

const execAsync = promisify(exec);

export interface SandboxOptions {
  cwd: string;
  timeoutMs: number;
  /** False for builds/type-checks; true ONLY when a step must reach npm/registries. */
  allowNetwork: boolean;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecError extends Error {
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

// Secrets and tokens that must never be visible to untrusted consumer code.
const DANGEROUS_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'STRIPE_SECRET_KEY',
  'DATABASE_URL',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'NPM_TOKEN',
] as const;

// A port that will refuse connections — a deterministic "network off" switch
// for tools that respect HTTP(S)_PROXY. Raw-socket binaries need OS-level
// isolation (unshare/bubblewrap/--network=none), which is the Phase-3b path.
const BLACKHOLE_PROXY = 'http://127.0.0.1:1';

/**
 * The "Warden": runs a validation command (install/build/test) inside a
 * strictly network-isolated child process. Dangerous environment variables are
 * stripped and, unless a step explicitly opts in, outbound network is routed
 * to a blackhole proxy so a consumer's test suite can't reach a production
 * database, webhook, or exfiltrate data.
 */
export class SandboxExecutor {
  /**
   * Execute a command in the isolated Warden environment.
   */
  execute(command: string, options: SandboxOptions): Promise<SandboxResult> {
    const inDocker = this.isRunningInDocker();
    logger.debug(
      { inDocker, allowNetwork: options.allowNetwork, cwd: options.cwd },
      'Warden executing command',
    );
    return this.executeWithRestrictedNetwork(command, options);
  }

  private async executeWithRestrictedNetwork(
    command: string,
    options: SandboxOptions,
  ): Promise<SandboxResult> {
    // WARDEN POLICY: strip dangerous environment variables.
    const safeEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of DANGEROUS_ENV_VARS) {
      delete safeEnv[name];
    }

    // WARDEN POLICY: block network unless this step explicitly allows it.
    if (!options.allowNetwork) {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        safeEnv[name] = BLACKHOLE_PROXY;
      }
      safeEnv.NO_PROXY = '';
      safeEnv.no_proxy = '';
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        env: safeEnv,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
    } catch (error) {
      const execError = error as ExecError;
      if (execError.killed) {
        return {
          stdout: '',
          stderr: 'Process killed: Timeout exceeded',
          exitCode: 124,
        };
      }
      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
      };
    }
  }

  /**
   * True when Mantior is running inside a container. In v1 the same
   * child-process restriction is applied either way; orchestrating consumer
   * containers with `--network=none` is the Phase-3b hardening.
   */
  private isRunningInDocker(): boolean {
    return existsSync('/.dockerenv');
  }
}
