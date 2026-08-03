import crypto from 'node:crypto';

import express from 'express';

import { logger } from '../logger';
import { Orchestrator } from '../orchestrator';
import { getVersion } from '../version';

import { webhookRateLimiter } from './rate-limit';

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const CONFIG_PATH = process.env.MANTIOR_CONFIG ?? 'mantior.yaml';

/**
 * Verify GitHub's X-Hub-Signature-256 (HMAC-SHA256) in constant time.
 * Production fails CLOSED when no secret is configured — signature checks are
 * non-negotiable for a tool that auto-opens PRs.
 */
export function verifyGitHubSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('Webhook secret not configured; rejecting in production');
      return false;
    }
    // Local/dev convenience: warn, but never silently fail open in prod.
    logger.warn('Webhook secret not configured; allowing unverified requests (dev only)');
    return true;
  }

  if (!signatureHeader) {
    logger.warn('Missing X-Hub-Signature-256 header');
    return false;
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    logger.warn({ signatureHeader }, 'Invalid signature format');
    return false;
  }
  const received = parts[1] ?? '';

  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  const receivedBuffer = Buffer.from(received, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (receivedBuffer.length !== expectedBuffer.length) {
    logger.warn('Webhook signature length mismatch');
    return false;
  }

  const isValid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  if (!isValid) {
    logger.warn(
      {
        receivedSignature: `${received.slice(0, 10)}…`,
        expectedSignature: `${expected.slice(0, 10)}…`,
      },
      'Webhook signature verification failed',
    );
  }
  return isValid;
}

export function setupWebhookRoutes(app: express.Express): void {
  // Signed webhook receiver.
  app.post('/webhook', webhookRateLimiter, express.json({ limit: '10mb' }), (req, res) => {
    try {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const body: unknown = req.body;
      const payload = JSON.stringify(body);

      if (!verifyGitHubSignature(payload, signature, WEBHOOK_SECRET)) {
        logger.warn({ ip: req.ip }, 'Failed webhook signature verification');
        res.status(403).json({ error: 'Invalid webhook signature' });
        return;
      }

      const event = (req.headers['x-github-event'] as string | undefined) ?? 'unknown';
      const deliveryId = (req.headers['x-github-delivery'] as string | undefined) ?? 'unknown';
      logger.info({ event, deliveryId }, 'Received webhook');

      handleWebhookEvent(bodyRecord(body), event);

      res.status(200).json({ status: 'ok', event, deliveryId });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Webhook handler error',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GitHub pings this when the webhook is configured/tested.
  app.get('/webhook/ping', (_req, res) => {
    res.json({
      status: 'ok',
      message: 'Mantior webhook endpoint is live',
      version: getVersion(),
      config: { hasSecret: WEBHOOK_SECRET !== '', configPath: CONFIG_PATH },
    });
  });
}

// ──────────────────────────────────────────────
// EVENT ROUTING
// ──────────────────────────────────────────────

function handleWebhookEvent(payload: Record<string, unknown>, event: string): void {
  switch (event) {
    case 'ping':
      logger.info('Webhook ping received from GitHub');
      break;
    case 'push':
      handlePushEvent(payload);
      break;
    case 'pull_request':
      handlePullRequestEvent(payload);
      break;
    case 'check_suite':
      logger.debug({ payload: summarize(payload) }, 'Check suite event received');
      break;
    default:
      logger.debug({ event }, 'Unhandled webhook event type');
  }
}

function handlePushEvent(payload: Record<string, unknown>): void {
  const repo = stringField(payload, ['repository', 'full_name']) ?? 'unknown';
  const branch = stringField(payload, ['ref'])?.replace('refs/heads/', '') ?? 'unknown';
  logger.info({ repo, branch }, 'Push event received');

  const commits = asRecordList(payload.commits);
  const files = commits.flatMap(commit => [
    ...asStringList(commit.added),
    ...asStringList(commit.modified),
  ]);
  const specFiles = files.filter(
    file =>
      file.includes('spec') ||
      file.includes('openapi') ||
      file.includes('swagger') ||
      file.endsWith('.yaml') ||
      file.endsWith('.yml') ||
      file.endsWith('.json'),
  );

  if (specFiles.length === 0) {
    logger.debug({ repo }, 'Push does not affect API specs, skipping');
    return;
  }

  logger.info({ repo, specFiles }, 'API spec changed, triggering scan');
  void runBackgroundScan(repo);
}

function handlePullRequestEvent(payload: Record<string, unknown>): void {
  const repo = stringField(payload, ['repository', 'full_name']) ?? 'unknown';
  const action = stringField(payload, ['action']) ?? 'unknown';
  const prNumber = numberField(payload, ['pull_request', 'number']);
  const merged = boolField(payload, ['pull_request', 'merged']);

  logger.debug({ repo, action, prNumber, merged }, 'Pull request event received');

  if (action === 'closed' && merged) {
    const pullRequest = asRecord(payload.pull_request);
    const fileNames = asRecordList(pullRequest.files)
      .map(file => stringField(file, ['filename']) ?? '')
      .filter(name => name.length > 0);
    const specFiles = fileNames.filter(name => name.includes('spec') || name.includes('openapi'));
    if (specFiles.length > 0) {
      logger.info(
        { repo, prNumber, specFiles: specFiles.length },
        'Spec changes merged, triggering scan',
      );
      void runBackgroundScan(repo);
    }
  }
}

function runBackgroundScan(repo: string): Promise<void> {
  return new Promise(resolvePromise => {
    setImmediate(() => {
      void (async () => {
        try {
          const orchestrator = new Orchestrator(process.env.SLACK_WEBHOOK);
          await orchestrator.run(CONFIG_PATH);
          logger.info({ repo }, 'Scan triggered by webhook completed');
        } catch (error) {
          logger.error(
            { repo, error: error instanceof Error ? error.message : String(error) },
            'Scan triggered by webhook failed',
          );
        }
      })();
      resolvePromise();
    });
  });
}

// ──────────────────────────────────────────────
// PAYLOAD NAVIGATION HELPERS (typed, no `any`)
// ──────────────────────────────────────────────

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function stringField(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current)[key];
    if (current === undefined) {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

function numberField(record: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current)[key];
    if (current === undefined) {
      return undefined;
    }
  }
  return typeof current === 'number' ? current : undefined;
}

function boolField(record: Record<string, unknown>, path: string[]): boolean {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current)[key];
    if (current === undefined) {
      return false;
    }
  }
  return current === true;
}

function summarize(payload: Record<string, unknown>): Record<string, unknown> {
  return { keys: Object.keys(payload).slice(0, 10) };
}
