import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

/**
 * Shared pino logger singleton.
 *
 * Pretty-prints when attached to a TTY (local dev), otherwise emits JSON lines
 * (CI, Docker, --json CLI output). Level comes from LOG_LEVEL.
 */
function buildLogger(): PinoLogger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const options: LoggerOptions = { level, timestamp: pino.stdTimeFunctions.isoTime };

  const usePretty =
    Boolean(process.stdout.isTTY) && process.env.CI !== 'true' && !process.argv.includes('--json');

  if (usePretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    };
  }

  return pino(options);
}

export const logger: PinoLogger = buildLogger();

export type { PinoLogger as Logger };
