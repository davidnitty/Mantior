import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { interpolateCommand, resolvePackageManager } from '../package-manager';

describe('package manager detection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-pm-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  let detectCounter = 0;
  const detect = (files: string[], override?: string): string => {
    // Each detection gets its own subdir so lockfiles never leak between cases.
    const dir = join(testDir, `case-${detectCounter++}`);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file), '');
    }
    return resolvePackageManager(dir, override);
  };

  it('detects go from go.mod', () => {
    expect(detect(['go.mod'])).toBe('go');
  });

  it('detects npm from package-lock.json', () => {
    expect(detect(['package-lock.json'])).toBe('npm');
  });

  it('detects yarn, pnpm, pip and poetry', () => {
    expect(detect(['yarn.lock'])).toBe('yarn');
    expect(detect(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(detect(['requirements.txt'])).toBe('pip');
    expect(detect(['poetry.lock'])).toBe('poetry');
  });

  it('defaults to npm when no lockfile is present', () => {
    expect(resolvePackageManager(testDir, 'auto')).toBe('npm');
  });

  it('honors an explicit override', () => {
    expect(detect(['package-lock.json'], 'pnpm')).toBe('pnpm');
    expect(detect([], 'poetry')).toBe('poetry');
  });

  it('interpolates the {pm} placeholder', () => {
    expect(interpolateCommand('{pm} install', 'npm')).toBe('npm install');
    expect(interpolateCommand('{pm} run type-check', 'yarn')).toBe('yarn run type-check');
    expect(interpolateCommand('{pm} test && {pm} run build', 'pnpm')).toBe(
      'pnpm test && pnpm run build',
    );
  });
});
