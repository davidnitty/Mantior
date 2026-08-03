import axios from 'axios';

import { logger } from './logger';

export interface SlackMessage {
  text: string;
  fields?: Record<string, string>;
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
