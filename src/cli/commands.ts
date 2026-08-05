import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';
import { type Command } from 'commander';

import { loadConfig } from '../config/loader';
import { startHealthServer } from '../health-server';
import { Orchestrator } from '../orchestrator';
import { MantiorDatabase } from '../state/database';
import { getVersion } from '../version';

import { autonomyCommand } from './autonomy-command';
import { logsCommand } from './logs-command';
import { statusCommand } from './status-command';

// ──────────────────────────────────────────────
// GLOBAL OPTIONS
// ──────────────────────────────────────────────

export function setupGlobalCommands(program: Command): void {
  program
    .name('mantior')
    .description('🛡️ Guardians of Your API Evolution.')
    .version(getVersion())
    .option('-v, --verbose', 'Enable verbose logging');
  // NOTE: `--config` / `--json` live on the subcommands only — duplicating them
  // on the root makes commander shadow the subcommand flags (validate/scan were
  // silently reading the default config instead of `-c <path>`).
}

interface InitOptions {
  force?: boolean;
}

export function setupInitCommand(program: Command): void {
  program
    .command('init')
    .description('Generate a sample mantior.yaml configuration file')
    .option('-f, --force', 'Overwrite existing config')
    .action((options: InitOptions) => {
      const configPath = resolve(process.cwd(), 'mantior.yaml');

      if (existsSync(configPath) && !options.force) {
        console.log(chalk.yellow('⚠️  mantior.yaml already exists. Use --force to overwrite.'));
        return;
      }

      // Detect the git remote to suggest a consumer repo URL.
      let gitRemote = '';
      try {
        gitRemote = execSync('git config --get remote.origin.url', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        // Not a git repo — fine, use the example URL.
      }
      const consumerRepo =
        gitRemote !== ''
          ? gitRemote.replace(/\.git$/, '') + '.git'
          : 'https://github.com/your-org/consumer-repo.git';
      const apiBase =
        gitRemote !== ''
          ? 'https://api.myapi.com/v1/openapi.json'
          : 'https://api.example.com/v1/openapi.json';

      const sampleConfig = `# 🛡️ Mantior Configuration
# ────────────────────────────
# Generated: ${new Date().toISOString()}

api:
  name: "My API"
  spec: ./specs/api-v2.yaml
  reference_url: "${apiBase}"

consumers:
  - repo: "${consumerRepo}"
    branch: "main"
    language: "typescript"

security:
  github_token: \${GITHUB_TOKEN}

rules:
  auto_pr: true
  default_reviewer: "@api-team"
  pr_labels: ["dependencies", "mantior"]

mappings:
  - old_path: "response.body.old_field"
    new_path: "response.body.new_field"

notifications:
  slack_webhook: \${SLACK_WEBHOOK}
`;

      writeFileSync(configPath, sampleConfig, 'utf8');
      console.log(chalk.green('✅ Created mantior.yaml'));
      console.log(chalk.gray('\n  Next steps:'));
      console.log(chalk.gray('  1. Edit mantior.yaml with your API details'));
      console.log(chalk.gray('  2. Create ./specs/ directory and add your OpenAPI specs'));
      console.log(chalk.gray('  3. Set GITHUB_TOKEN in .env'));
      console.log(chalk.gray('  4. Run: mantior scan'));
    });
}

interface ValidateOptions {
  config?: string;
}

export function setupValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate your mantior.yaml configuration')
    .option('-c, --config <path>', 'Path to config file')
    .action((options: ValidateOptions) => {
      const configPath = options.config || process.env.MANTIOR_CONFIG || 'mantior.yaml';
      const absolutePath = resolve(process.cwd(), configPath);

      if (!existsSync(absolutePath)) {
        console.log(chalk.red(`❌ Config file not found: ${absolutePath}`));
        console.log(chalk.gray('  Run "mantior init" to create one.'));
        process.exit(1);
      }

      try {
        console.log(chalk.blue('🔍 Validating config...'));
        const config = loadConfig(absolutePath);

        const errors: string[] = [];
        if (!config.security.github_token && !process.env.GITHUB_TOKEN) {
          errors.push('GITHUB_TOKEN must be set in .env or config');
        }
        if (config.consumers.length === 0) {
          errors.push('At least one consumer is required');
        }

        if (errors.length > 0) {
          console.log(chalk.red('❌ Config validation failed:'));
          for (const error of errors) {
            console.log(chalk.red(`  • ${error}`));
          }
          process.exit(1);
        }

        const specPath = config.api.spec;
        const specExists = existsSync(
          specPath.startsWith('/') ? specPath : resolve(process.cwd(), specPath),
        );

        console.log(chalk.green('✅ Config is valid!'));
        console.log(chalk.gray(`  API: ${config.api.name}`));
        console.log(chalk.gray(`  Consumers: ${config.consumers.length}`));
        console.log(chalk.gray(`  Mappings: ${config.mappings.length}`));
        console.log(
          chalk.gray(
            `  Spec: ${config.api.spec}${specExists ? '' : chalk.yellow(' (⚠️ not found)')}`,
          ),
        );
      } catch (error) {
        console.log(chalk.red('❌ Config validation failed:'));
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });
}

interface ScanOptions {
  config?: string;
  json?: boolean;
}

export function setupScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan for breaking changes without applying fixes')
    .option('-c, --config <path>', 'Path to config file')
    .option('--json', 'Output results in JSON format')
    .action(async (options: ScanOptions) => {
      const configPath = options.config || process.env.MANTIOR_CONFIG || 'mantior.yaml';
      console.log(chalk.blue('🔍 Mantior Scanning...\n'));

      try {
        const config = loadConfig(configPath);
        const { DiffEngine } = await import('../diff/engine');
        const engine = new DiffEngine();
        const changes = await engine.compare(config.api.reference_url, config.api.spec);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                changes,
                summary: {
                  total: changes.length,
                  breaking: changes.filter(change => change.severity === 'breaking').length,
                  risky: changes.filter(change => change.severity === 'risky').length,
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        if (changes.length === 0) {
          console.log(chalk.green('✅ No breaking changes detected!'));
          return;
        }

        const breaking = changes.filter(change => change.severity === 'breaking');
        const risky = changes.filter(change => change.severity === 'risky');
        console.log(chalk.yellow(`⚠️  Found ${changes.length} changes:\n`));

        if (breaking.length > 0) {
          console.log(chalk.red(`  🔴 Breaking (${breaking.length}):`));
          breaking.forEach((change, index) => {
            console.log(chalk.red(`    ${index + 1}. ${change.message}`));
          });
          if (breaking.length > 0) {
            console.log('');
          }
        }

        if (risky.length > 0) {
          console.log(chalk.yellow(`  🟡 Risky (${risky.length}):`));
          risky.forEach((change, index) => {
            console.log(chalk.yellow(`    ${index + 1}. ${change.message}`));
          });
          console.log('');
        }

        console.log(chalk.gray('\n  Run "mantior fix" to automatically fix these changes.'));
      } catch (error) {
        console.log(chalk.red('❌ Scan failed:'));
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });
}

interface FixOptions {
  config?: string;
  dryRun?: boolean;
  pr?: boolean;
  json?: boolean;
}

export function setupFixCommand(program: Command): void {
  program
    .command('fix')
    .description('Scan and automatically fix breaking changes (opens PRs)')
    .option('-c, --config <path>', 'Path to config file')
    .option('--dry-run', 'Show what would be fixed without actually fixing')
    .option('--no-pr', 'Apply fixes locally but do NOT open PRs')
    .option('--json', 'Output results in JSON format')
    .action(async (options: FixOptions) => {
      const configPath = options.config || process.env.MANTIOR_CONFIG || 'mantior.yaml';
      const noPr = options.pr === false; // commander: --no-pr sets pr=false
      const dryRun = options.dryRun ?? false;

      console.log(chalk.blue('\n   🛡️  MANTIOR'));
      console.log(chalk.gray('   Guardians of Your API Evolution.\n'));

      try {
        if (!process.env.GITHUB_TOKEN && !options.dryRun) {
          console.log(chalk.yellow('⚠️  GITHUB_TOKEN not set. Use --dry-run or set it in .env.'));
          console.log(chalk.gray('  See: https://github.com/settings/tokens'));
          process.exit(1);
        }

        const config = loadConfig(configPath);
        console.log(chalk.gray(`📋 API: ${config.api.name}`));
        console.log(chalk.gray(`📦 Consumers: ${config.consumers.length}`));

        if (dryRun) {
          console.log(chalk.yellow('\n🧪 DRY RUN MODE – No PRs will be opened.\n'));
        }
        if (noPr) {
          console.log(chalk.yellow('\n🚫 PRs disabled --no-pr – fixes applied locally.\n'));
        }

        const orchestrator = new Orchestrator(process.env.SLACK_WEBHOOK);
        const result = await orchestrator.run(configPath, { dryRun: dryRun || noPr });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.green('\n✅ Scan completed!'));
        console.log(chalk.gray(`  Duration: ${result.durationSec.toFixed(1)}s`));
        console.log(chalk.gray(`  Changes: ${result.changesDetected}`));
        console.log(chalk.gray(`  PRs Opened: ${result.prsOpened}`));
        console.log(chalk.gray(`  Manual Interventions: ${result.manualInterventions}`));
        if (result.errorsCount > 0) {
          console.log(chalk.yellow(`  Errors: ${result.errorsCount}`));
        }

        const db = MantiorDatabase.getInstance();
        const latestScan = db.getLatestScan();
        if (latestScan) {
          console.log(chalk.gray(`  Scan #${latestScan.id} recorded at ${latestScan.timestamp}`));
        }
      } catch (error) {
        console.log(chalk.red('❌ Fix failed:'));
        console.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        if (error instanceof Error && error.stack) {
          console.log(chalk.gray(`\n  ${error.stack.slice(0, 500)}...`));
        }
        process.exit(1);
      }
    });
}

export function setupStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current Mantior status and historical metrics')
    .option('--json', 'Output in JSON format')
    .action((options: { json?: boolean }) => {
      void statusCommand(options);
    });
}

interface LogsOptions {
  tail?: number;
  json?: boolean;
}

export function setupLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Show recent Mantior logs')
    .option('-n, --tail <number>', 'Number of lines to show', '50')
    .option('--json', 'Output in JSON format')
    .action((options: LogsOptions) => {
      const tail = Number.parseInt(options.tail === undefined ? '50' : String(options.tail), 10);
      void logsCommand({ tail: Number.isInteger(tail) ? tail : 50, json: options.json });
    });
}

interface AutonomyOptions {
  list?: boolean;
  get?: string;
  set?: string;
  export?: string;
  logs?: boolean;
  tail?: number;
}

export function setupAutonomyCommand(program: Command): void {
  program
    .command('autonomy')
    .description('Manage autonomy levels and permissions')
    .option('--list', 'List current autonomy configuration')
    .option('--get <key>', 'Get a specific configuration value')
    .option('--set <level>', 'Set autonomy level (1-5)')
    .option('--export <file>', 'Export an autonomy report (JSON)')
    .option('--logs', 'Show recent autonomy decisions')
    .option('--tail <number>', 'Number of decision log rows', '20')
    .action((options: AutonomyOptions) => {
      const tail = Number.parseInt(options.tail === undefined ? '20' : String(options.tail), 10);
      void autonomyCommand({
        list: options.list,
        get: options.get,
        set: options.set,
        export: options.export,
        logs: options.logs,
        tail: Number.isInteger(tail) ? tail : 20,
      });
    });
}

interface ServerOptions {
  port?: string;
  watch?: boolean;
}

export function setupServerCommand(program: Command): void {
  program
    .command('server')
    .description('Run Mantior as a background server with webhooks')
    .option('-p, --port <number>', 'Port for health/metrics server', '8080')
    .option('--watch', 'Watch for config changes and auto-reload (Phase 2)')
    .action((options: ServerOptions) => {
      const port = Number.parseInt(options.port ?? process.env.HEALTH_PORT ?? '8080', 10);
      const watch = options.watch ?? false;
      console.log(
        chalk.blue(
          `🛡️  Mantior Server starting on port ${port}...${watch ? ' (watch: Phase 2)' : ''}`,
        ),
      );

      startHealthServer(port);
      console.log(chalk.green('✅ Mantior Server running'));
      console.log(chalk.gray(`  Health:    http://localhost:${port}/health`));
      console.log(chalk.gray(`  Metrics:   http://localhost:${port}/metrics`));
      console.log(chalk.gray(`  Webhook:   http://localhost:${port}/webhook`));
      console.log(chalk.gray('\n  Press Ctrl+C to stop.\n'));

      const shutdown = (): void => {
        console.log(chalk.gray('\n  Stopping Mantior server.'));
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
