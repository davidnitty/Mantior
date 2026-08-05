#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';

import {
  setupAutonomyCommand,
  setupFixCommand,
  setupGlobalCommands,
  setupInitCommand,
  setupLogsCommand,
  setupScanCommand,
  setupServerCommand,
  setupStatusCommand,
  setupValidateCommand,
} from './cli/commands';
import { initTracing } from './tracing';

// Load environment variables first so config interpolation and logging see them.
dotenv.config();
initTracing();

const program = new Command();

setupGlobalCommands(program);
setupInitCommand(program);
setupValidateCommand(program);
setupAutonomyCommand(program);
setupScanCommand(program);
setupFixCommand(program);
setupStatusCommand(program);
setupLogsCommand(program);
setupServerCommand(program);

// Show help when run with no arguments.
if (process.argv.length === 2) {
  program.outputHelp();
} else {
  program.parse(process.argv);
}
