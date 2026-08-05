import axios from 'axios';

import { logger } from './logger';

export interface SlackMessage {
  text: string;
  fields?: Record<string, string>;
}

export interface NotifyEnvelope {
  title: string;
  message: string;
  severity?: 'info' | 'success' | 'warn' | 'error';
  metadata?: Record<string, unknown>;
}

/**
 * Slack + console alerts. No-op (console only) when no webhook is configured,
 * so Mantior works out of the box in local/dev contexts.
 */
export class Notifier {
  constructor(private readonly slackWebhook?: string) {}

  get enabled(): boolean {
    return Boolean(this.slackWebhook);
  }

  async notify(message: SlackMessage): Promise<void> {
    logger.info(message.text, message.fields);
    if (!this.slackWebhook) {
      return;
    }
    try {
      await axios.post(
        this.slackWebhook,
        { text: message.text, attachments: this.toAttachments(message.fields) },
        { timeout: 10_000 },
      );
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, 'Slack notification failed');
    }
  }

  /** Structured envelope (title/message/severity/metadata) → Slack + logs. */
  async send(envelope: NotifyEnvelope): Promise<void> {
    const prefix =
      envelope.severity === 'error'
        ? '❌'
        : envelope.severity === 'warn'
          ? '⚠️'
          : envelope.severity === 'success'
            ? '✅'
            : '📝';
    await this.notify({
      text: `${prefix} ${envelope.title} — ${envelope.message}`,
      fields: envelope.metadata ? stringifyValues(envelope.metadata) : undefined,
    });
  }

  private toAttachments(
    fields?: Record<string, string>,
  ): Array<{ color: string; fields: Array<{ title: string; value: string; short: boolean }> }> {
    if (!fields) {
      return [];
    }
    return [
      {
        color: '#36a64f',
        fields: Object.entries(fields).map(([title, value]) => ({ title, value, short: true })),
      },
    ];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyValues(metadata: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return result;
}
