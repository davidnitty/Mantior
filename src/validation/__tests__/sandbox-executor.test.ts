import { afterEach, describe, expect, it } from '@jest/globals';

import { SandboxExecutor } from '../sandbox-executor';

describe('SandboxExecutor', () => {
  const sandbox = new SandboxExecutor();

  afterEach(() => {
    // jest.setup seeds GITHUB_TOKEN; restore it for other suites.
    process.env.GITHUB_TOKEN = 'test-token';
  });

  it('runs a command and returns its stdout with exit code 0', async () => {
    const result = await sandbox.execute('node -e "console.log(\'warden-ok\')"', {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      allowNetwork: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('warden-ok');
  });

  it('strips dangerous environment variables from the child', async () => {
    process.env.GITHUB_TOKEN = 'super-secret-token';
    process.env.DATABASE_URL = 'postgres://prod:secret@db/prod';

    const result = await sandbox.execute(
      "node -e \"console.log(process.env.GITHUB_TOKEN || 'STRIPPED_GH'); console.log(process.env.DATABASE_URL || 'STRIPPED_DB')\"",
      { cwd: process.cwd(), timeoutMs: 30_000, allowNetwork: true },
    );

    expect(result.stdout).toContain('STRIPPED_GH');
    expect(result.stdout).toContain('STRIPPED_DB');
    expect(result.stdout).not.toContain('super-secret-token');
    expect(result.stdout).not.toContain('postgres://');
  });

  it('blackholes the network when allowNetwork is false', async () => {
    const result = await sandbox.execute(
      'node -e "console.log(process.env.HTTP_PROXY || \'NO_PROXY\')"',
      { cwd: process.cwd(), timeoutMs: 30_000, allowNetwork: false },
    );

    expect(result.stdout).toContain('127.0.0.1:1');
  });

  it('leaves the network untouched when allowNetwork is true', async () => {
    const result = await sandbox.execute(
      'node -e "console.log(process.env.HTTP_PROXY || \'NO_PROXY\')"',
      { cwd: process.cwd(), timeoutMs: 30_000, allowNetwork: true },
    );

    expect(result.stdout).not.toContain('127.0.0.1:1');
  });

  it('reports exit code 124 when a command exceeds its timeout', async () => {
    const result = await sandbox.execute('node -e "setTimeout(function(){}, 5000)"', {
      cwd: process.cwd(),
      timeoutMs: 500,
      allowNetwork: false,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Timeout exceeded');
  });
});
