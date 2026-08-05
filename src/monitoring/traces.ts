import { trace, type Attributes, type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api';

/**
 * OpenTelemetry tracer wrapper. The OTel API is dependency-light and no-ops
 * until an SDK/provider is installed (Phase 2: exporters, context propagation);
 * `initTracing()` in src/tracing.ts remains the enablement seam.
 */
export class TracerManager {
  private readonly tracer: Tracer;

  constructor() {
    this.tracer = trace.getTracer('mantior');
  }

  startSpan(name: string, attributes?: Record<string, string>): Span {
    const span = this.tracer.startSpan(name);
    if (attributes) {
      span.setAttributes(attributes);
    }
    return span;
  }

  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string>,
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.addEvent(name, attributes as Attributes);
  }

  setAttribute(span: Span, key: string, value: unknown): void {
    span.setAttribute(key, stringifyAttribute(value));
  }
}

export const tracer = new TracerManager();

function stringifyAttribute(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
