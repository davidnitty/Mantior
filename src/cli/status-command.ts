import chalk from 'chalk';
import Table from 'cli-table3';

import { MantiorDatabase } from '../state/database';
import { getVersion } from '../version';

export interface StatusOptions {
  json?: boolean;
}

export function statusCommand(options: StatusOptions): void {
  const db = MantiorDatabase.getInstance();
  const summary = db.getStatusSummary();

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const healthy = summary.latestScan === undefined ? true : summary.latestScan.status !== 'failed';
  const table = new Table({
    head: ['Metric', 'Value'],
    style: { head: ['cyan'] },
    colWidths: [24, 40],
  });

  table.push(['Version', chalk.green(getVersion())]);
  table.push(['Status', healthy ? chalk.green('✅ Healthy') : chalk.red('⚠️  Degraded')]);
  table.push([
    'Last Scan',
    summary.latestScan ? summary.latestScan.timestamp : chalk.gray('never'),
  ]);
  table.push(['Total Scans', String(summary.totalScans)]);
  table.push(['Total Changes Detected', String(summary.totalChangesDetected)]);
  table.push(['Total PRs Opened', String(summary.totalPRsOpened)]);
  table.push(['Consumers Monitored', String(summary.consumersMonitored)]);
  table.push(['Error Rate', `${summary.errorRate.toFixed(1)}%`]);

  console.log(chalk.blue('\n🛡️  Mantior Status\n'));
  console.log(table.toString());
  if (summary.latestScan) {
    console.log(
      chalk.gray(
        `  Latest scan: ${summary.latestScan.status} · ${summary.latestScan.duration.toFixed(1)}s · ${summary.latestScan.changes_detected} change(s)`,
      ),
    );
  }
}
