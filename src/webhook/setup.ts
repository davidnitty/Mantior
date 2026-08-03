import { Octokit } from '@octokit/rest';

import { logger } from '../logger';

export interface WebhookConfig {
  owner: string;
  repo: string;
  webhookUrl: string;
  secret: string;
  events?: string[];
}

const DEFAULT_EVENTS = ['push', 'pull_request', 'check_suite'];

/** Create (or update) a signed GitHub repo webhook pointing at Mantior's server. */
export async function setupGitHubWebhook(
  config: WebhookConfig,
  githubToken: string,
): Promise<void> {
  const octokit = new Octokit({ auth: githubToken, userAgent: 'Mantior/1.0' });
  const events = config.events ?? DEFAULT_EVENTS;

  try {
    const { data: hooks } = await octokit.repos.listWebhooks({
      owner: config.owner,
      repo: config.repo,
    });
    const existing = hooks.find(hook => hook.config?.url === config.webhookUrl);

    if (existing) {
      logger.info({ owner: config.owner, repo: config.repo }, 'Webhook already exists, updating');
      await octokit.repos.updateWebhook({
        owner: config.owner,
        repo: config.repo,
        hook_id: existing.id,
        config: { url: config.webhookUrl, content_type: 'json', secret: config.secret },
        events,
        active: true,
      });
      return;
    }

    await octokit.repos.createWebhook({
      owner: config.owner,
      repo: config.repo,
      config: { url: config.webhookUrl, content_type: 'json', secret: config.secret },
      events,
      active: true,
    });
    logger.info({ owner: config.owner, repo: config.repo }, 'Webhook created successfully');
  } catch (error) {
    logger.error(
      {
        owner: config.owner,
        repo: config.repo,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to setup webhook',
    );
    throw error;
  }
}
