import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { MantiorConfig } from '../../config/loader';
import type { BreakingChange } from '../../diff/engine';
import { PROpener, PROpeningStrategy, parseRepoUrl } from '../pr-opener';

// Mocked GitHub/simple-git so the full PR-opening flow runs without a token.
const mockGit = {
  checkoutLocalBranch: jest.fn(),
  add: jest.fn(),
  commit: jest.fn(),
  push: jest.fn(),
  addRemote: jest.fn(),
};

const mockOctokitApi = {
  users: { getAuthenticated: jest.fn() },
  repos: {
    getCollaboratorPermissionLevel: jest.fn(),
    createFork: jest.fn(),
    listForks: jest.fn(),
  },
  pulls: { create: jest.fn(), requestReviewers: jest.fn() },
  issues: { addLabels: jest.fn() },
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => mockOctokitApi),
}));

jest.mock('simple-git', () => ({
  __esModule: true,
  default: jest.fn(() => mockGit),
}));

describe('PROpener (mocked GitHub)', () => {
  let testDir: string;

  const config: MantiorConfig = {
    api: { name: 'Test API', spec: 'spec.yaml', reference_url: 'http://example.com' },
    consumers: [],
    security: { github_token: 'test-token' },
    rules: { auto_pr: true, pr_labels: [] },
    mappings: [],
    notifications: {},
  };

  const change: BreakingChange = {
    type: 'property_removed',
    severity: 'breaking',
    confidence: 100,
    message: 'amount removed',
  };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-mock-'));
    mockGit.checkoutLocalBranch.mockResolvedValue(undefined);
    mockGit.add.mockResolvedValue(undefined);
    mockGit.commit.mockResolvedValue(undefined);
    mockGit.push.mockResolvedValue(undefined);
    mockGit.addRemote.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('parses https, ssh and plain repo URLs', () => {
    expect(parseRepoUrl('https://github.com/acme/web.git')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseRepoUrl('git@github.com:acme/web.git')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseRepoUrl('acme/web')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseRepoUrl('not-a-repo')).toBeNull();
  });

  it('opens a PR directly when the user has write access', async () => {
    mockOctokitApi.users.getAuthenticated.mockResolvedValue({ data: { login: 'mantior-bot' } });
    mockOctokitApi.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write' },
    });
    mockOctokitApi.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/web/pull/7', number: 7 },
    });
    mockOctokitApi.issues.addLabels.mockResolvedValue({});
    mockOctokitApi.pulls.requestReviewers.mockResolvedValue({});

    const opener = new PROpener(config);
    const result = await opener.createPR(
      testDir,
      'https://github.com/acme/web.git',
      'main',
      { 'README.md': '# fixed' },
      [change],
      { labels: ['automated'], reviewers: ['alice'] },
    );

    expect(result.strategy).toBe(PROpeningStrategy.DIRECT);
    expect(result.prNumber).toBe(7);
    expect(result.prUrl).toBe('https://github.com/acme/web/pull/7');
    expect(mockOctokitApi.issues.addLabels).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      issue_number: 7,
      labels: ['automated'],
    });
    expect(mockOctokitApi.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      pull_number: 7,
      reviewers: ['alice'],
    });
  });

  it('uses the fork strategy when preferred', async () => {
    mockOctokitApi.users.getAuthenticated.mockResolvedValue({ data: { login: 'mantior-bot' } });
    mockOctokitApi.repos.listForks.mockResolvedValue({
      data: [{ owner: { login: 'mantior-bot' } }],
    });
    mockOctokitApi.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/web/pull/8', number: 8 },
    });

    const opener = new PROpener(config);
    const result = await opener.createPR(
      testDir,
      'https://github.com/acme/web.git',
      'main',
      { 'README.md': '# fixed' },
      [change],
      { strategy: PROpeningStrategy.FORK },
    );

    expect(result.strategy).toBe(PROpeningStrategy.FORK);
    expect(mockGit.addRemote).toHaveBeenCalledTimes(1);
  });

  it('propagates PR creation failures', async () => {
    mockOctokitApi.users.getAuthenticated.mockResolvedValue({ data: { login: 'mantior-bot' } });
    mockOctokitApi.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write' },
    });
    mockOctokitApi.pulls.create.mockRejectedValue(new Error('API Error'));

    const opener = new PROpener(config);
    await expect(
      opener.createPR(testDir, 'https://github.com/acme/web.git', 'main', {}, [change]),
    ).rejects.toThrow('API Error');
  });

  it('rejects invalid repo URLs', async () => {
    const opener = new PROpener(config);
    await expect(
      opener.createPR(testDir, 'https://not-github.com/x', 'main', {}, [change]),
    ).rejects.toThrow('Invalid repo URL');
  });
});
