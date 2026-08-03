import chalk from 'chalk';

import { MantiorDatabase } from '../state/database';

export interface LogsOptions {
  tail?: number;
  json?: boolean;
}

const EVENT_ICONS = { scan: '🔍', pr: '🚀', error: '❌' } as const;

export function logsCommand(options: LogsOptions): void {
  const db = MantiorDatabase.getInstance();
  const limit = options.tail ?? 50;
  const entries = db.getRecentActivity(limit);

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log(chalk.blue(`📝 Recent activity (last ${entries.length})\n`));
  for (const entry of entries) {
    const icon = EVENT_ICONS[entry.kind];
    const color =
      entry.kind === 'error' ? chalk.red : entry.kind === 'pr' ? chalk.green : chalk.gray;
    console.log(`${icon} ${color(entry.timestamp)}  ${entry.summary}`);
  }
  if (entries.length === 0) {
    console.log(chalk.gray('  No activity yet. Run "mantior fix" to create a scan.'));
  }
}
