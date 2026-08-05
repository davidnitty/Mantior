import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';
import Table from 'cli-table3';

import { AutonomyLevel, AutonomyManager } from '../autonomy/levels';
import { MantiorDatabase } from '../state/database';

export interface AutonomyCommandOptions {
  list?: boolean;
  get?: string;
  set?: string;
  export?: string;
  logs?: boolean;
  tail?: number;
}

const LEVEL_ROWS = [
  { level: 1, name: 'Observe', action: 'Monitor only', confidence: 'N/A' },
  { level: 2, name: 'Recommend', action: 'Propose fixes', confidence: '≥ 30%' },
  { level: 3, name: 'Simulate', action: 'Sandbox testing', confidence: '≥ 50%' },
  { level: 4, name: 'Execute with Approval', action: 'PR + human approval', confidence: '≥ 70%' },
  {
    level: 5,
    name: 'Execute Automatically',
    action: 'Auto-merge safe changes',
    confidence: '≥ 90%',
  },
];

export function autonomyCommand(options: AutonomyCommandOptions): void {
  const manager = new AutonomyManager();

  if (options.list || options.get === 'config') {
    printConfig(manager);
    return;
  }

  if (options.export) {
    exportReport(manager, options.export);
    return;
  }

  if (options.logs) {
    printLogs(options.tail ?? 20);
    return;
  }

  if (options.set) {
    setLevel(manager, options.set);
    return;
  }

  // No options → show the current level.
  console.log(chalk.blue('\n🎯 MANTIOR AUTONOMY'));
  console.log(chalk.bold('Current Level:'));
  console.log(
    `  ${chalk.green(AutonomyLevel[manager.getCurrentLevel()])} (Level ${manager.getCurrentLevel()})`,
  );
  console.log(chalk.gray('\n  Use --list, --set <1-5>, --logs, or --export <file>.'));
}

function printConfig(manager: AutonomyManager): void {
  console.log(chalk.blue('\n🎯 MANTIOR AUTONOMY'));
  console.log(chalk.bold('\nCurrent Autonomy Level:'));
  console.log(
    `  ${chalk.green(AutonomyLevel[manager.getCurrentLevel()])} (Level ${manager.getCurrentLevel()})\n`,
  );

  console.log(chalk.bold('Configuration:'));
  console.log(manager.getConfigDescription());

  const table = new Table({
    head: ['Level', 'Name', 'Action', 'Confidence'],
    colWidths: [8, 18, 20, 14],
  });
  for (const row of LEVEL_ROWS) {
    table.push([row.level, row.name, row.action, row.confidence]);
  }
  console.log(table.toString());
}

function setLevel(manager: AutonomyManager, raw: string): void {
  const level = Number.parseInt(raw, 10);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    console.log(chalk.red('❌ Invalid level. Must be 1-5.'));
    console.log(chalk.gray('  Level 1: Observe'));
    console.log(chalk.gray('  Level 2: Recommend'));
    console.log(chalk.gray('  Level 3: Simulate'));
    console.log(chalk.gray('  Level 4: Execute with Approval'));
    console.log(chalk.gray('  Level 5: Execute Automatically'));
    process.exit(1);
  }
  manager.setUserLevel(level as AutonomyLevel);
  console.log(chalk.green(`✅ Autonomy level set to ${AutonomyLevel[level]} (Level ${level})`));
  console.log(chalk.gray('\n  Changes take effect on next scan.'));
}

function exportReport(manager: AutonomyManager, filePath: string): void {
  const db = MantiorDatabase.getInstance();
  const report = {
    exportedAt: new Date().toISOString(),
    currentLevel: manager.getCurrentLevel(),
    levelName: AutonomyLevel[manager.getCurrentLevel()],
    config: manager.getConfig(),
    recentDecisions: db.getRecentAutonomyLogs(100),
  };
  const absolute = resolve(process.cwd(), filePath);
  writeFileSync(absolute, JSON.stringify(report, null, 2), 'utf8');
  console.log(chalk.green(`✅ Autonomy report written to ${absolute}`));
}

function printLogs(tail: number): void {
  const db = MantiorDatabase.getInstance();
  const logs = db.getRecentAutonomyLogs(tail);
  const table = new Table({
    head: ['Time', 'Change', 'Level', 'Action', 'Conf', 'Approval'],
    colWidths: [22, 34, 12, 16, 8, 10],
  });
  for (const log of logs) {
    table.push([
      log.timestamp,
      log.change_message.slice(0, 32),
      AutonomyLevel[log.effective_level as AutonomyLevel] ?? String(log.effective_level),
      log.action_taken,
      `${log.confidence_score}`,
      log.requires_approval ? 'required' : 'not required',
    ]);
  }
  console.log(chalk.blue(`\n📋 Recent autonomy decisions (last ${logs.length})\n`));
  console.log(table.toString());
}
