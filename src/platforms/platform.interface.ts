// ──────────────────────────────────────────────
// MULTI-PLATFORM SEAM (v1: GitHub only)
// ──────────────────────────────────────────────
// Mantior ships GitHub-first (v1). This interface is the contract GitLab (v2,
// via @gitbeaker/rest) and Bitbucket (v3) implementations will satisfy. The
// v1 GitHub implementation lives in src/github/pr-opener.ts.
// ──────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface PRParams {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
}

export interface PRUpdateParams {
  repo: string;
  prNumber: number;
  state?: 'open' | 'closed';
  title?: string;
  body?: string;
}

export interface PRResult {
  number: number;
  url: string;
}

export interface PRInfo {
  number: number;
  url: string;
  state: string;
}

export interface FileUpdateParams {
  repo: string;
  path: string;
  content: string;
  branch: string;
}

export interface WebhookParams {
  repo: string;
  url: string;
  secret: string;
  events: string[];
}

export interface CheckStatus {
  state: string;
  conclusion?: string;
}

export interface UserInfo {
  login: string;
}

export interface RepoPermissions {
  permission: string;
}

export interface PlatformClient {
  authenticate(token: string): Promise<void>;

  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  createBranch(owner: string, repo: string, branch: string, base: string): Promise<void>;

  createPR(params: PRParams): Promise<PRResult>;
  updatePR(params: PRUpdateParams): Promise<PRResult>;
  getPR(owner: string, repo: string, prNumber: number): Promise<PRInfo>;

  createFork(owner: string, repo: string): Promise<string>;
  hasFork(owner: string, repo: string): Promise<boolean>;

  getFile(owner: string, repo: string, path: string, ref?: string): Promise<string>;
  updateFile(params: FileUpdateParams): Promise<void>;

  createWebhook(params: WebhookParams): Promise<void>;
  deleteWebhook(params: WebhookParams): Promise<void>;

  getCheckStatus(owner: string, repo: string, ref: string): Promise<CheckStatus>;

  getCurrentUser(): Promise<UserInfo>;
  getRepoPermissions(owner: string, repo: string): Promise<RepoPermissions>;
}
