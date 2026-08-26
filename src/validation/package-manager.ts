import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'go';

const DETECTORS: Array<{ manager: PackageManager; files: string[] }> = [
  { manager: 'go', files: ['go.mod'] },
  { manager: 'npm', files: ['package-lock.json'] },
  { manager: 'yarn', files: ['yarn.lock'] },
  { manager: 'pnpm', files: ['pnpm-lock.yaml'] },
  { manager: 'poetry', files: ['poetry.lock', 'pyproject.toml'] },
  { manager: 'pip', files: ['requirements.txt', 'Pipfile'] },
];

/**
 * Detect the package manager for a cloned repo from its lockfiles, unless the
 * user configured an explicit override in mantior.yaml.
 */
export function resolvePackageManager(repoPath: string, override?: string): string {
  if (override && override !== 'auto') {
    return override;
  }
  for (const { manager, files } of DETECTORS) {
    if (files.some(file => existsSync(join(repoPath, file)))) {
      return manager;
    }
  }
  return 'npm';
}

/**
 * Replace the `{pm}` placeholder in a validation command with the resolved
 * package manager (e.g. `{pm} install` → `npm install`).
 */
export function interpolateCommand(command: string, packageManager: string): string {
  return command.replace(/\{pm\}/g, packageManager);
}
