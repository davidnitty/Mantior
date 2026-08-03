import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import simpleGit, { type SimpleGit } from 'simple-git';

import { logger } from '../logger';

/**
 * Clones consumer repositories to a fresh temp directory and cleans up after.
 * Shallow clones keep disk and network usage low when scanning many consumers.
 * All processing is ephemeral — no source code is persisted.
 */
export class RepoCloner {
  private readonly git: SimpleGit = simpleGit({ maxConcurrentProcesses: 1 });

  async clone(repoUrl: string, branch?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mantior-consumer-'));
    logger.info({ repoUrl, dir }, 'Cloning repository');

    const options: string[] = ['--depth', '1'];
    if (branch) {
      options.push('--branch', branch);
    }
    await this.git.clone(repoUrl, dir, options);
    return dir;
  }

  async cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
}
