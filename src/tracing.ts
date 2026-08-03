import { logger } from './logger';

/**
 * OpenTelemetry tracing entry point.
 *
 * Phase 2: swap the stub for a real OTEL SDK (tracing, span exporters,
 * distributed context propagation) — the call sites (initTracing at startup)
 * and the ENABLE_TRACING env toggle already exist.
 */
export function initTracing(): void {
  const enabled = process.env.ENABLE_TRACING === 'true';
  if (!enabled) {
    logger.debug('Tracing disabled (ENABLE_TRACING != true)');
    return;
  }
  logger.warn(
    'OpenTelemetry tracing is enabled but not yet implemented (Phase 2). ' +
      'Set ENABLE_TRACING=false to silence this warning.',
  );
}
