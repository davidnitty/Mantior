import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { BreakingChange } from '../../diff/engine';
import type { CallSite } from '../../scanner/ast-walker';
import { LLMFallback } from '../llm-fallback';

describe('LLMFallback', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const callSite: CallSite = {
    file: '/tmp/consumer/payment.ts',
    line: 5,
    column: 10,
    node: null,
    change: {} as BreakingChange,
    matchText: 'response.user.id',
    context: {
      surroundingCode: 'const id = response.user.id;',
      objectChain: ['response', 'user', 'id'],
    },
  };

  const change: BreakingChange = {
    type: 'property_renamed',
    severity: 'breaking',
    property: 'id',
    newProperty: 'uuid',
    oldValue: 'id',
    newValue: 'uuid',
    message: 'Property "id" renamed to "uuid" in schema "User".',
    confidence: 80,
  };

  const mockOpenAI = (body: unknown): void => {
    globalThis.fetch = jest.fn(() => ({
      ok: true,
      status: 200,
      json: () => ({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
    })) as unknown as typeof fetch;
  };

  it('returns needsManualReview when no API key is configured', async () => {
    const fallback = new LLMFallback('');
    const result = await fallback.attemptFix(callSite, 'content', change, {});
    expect(result.success).toBe(false);
    expect(result.needsManualReview).toBe(true);
  });

  it('applies a high-confidence fix', async () => {
    mockOpenAI({
      success: true,
      fixedCode: 'const uuid = response.user.uuid;',
      confidence: 85,
      explanation: 'renamed',
    });
    const fallback = new LLMFallback('sk-123');
    const result = await fallback.attemptFix(callSite, 'const id = response.user.id;', change, {});
    expect(result.success).toBe(true);
    expect(result.fixedContent).toContain('uuid');
    expect(result.needsManualReview).toBe(false);
  });

  it('flags low-confidence fixes for manual review', async () => {
    mockOpenAI({
      success: true,
      fixedCode: 'const id = response.user.uuid;',
      confidence: 40,
      explanation: 'not sure',
    });
    const fallback = new LLMFallback('sk-123');
    const result = await fallback.attemptFix(callSite, 'const id = response.user.id;', change, {});
    expect(result.success).toBe(true);
    expect(result.confidence).toBe(40);
    expect(result.needsManualReview).toBe(true);
  });

  it('handles an unparseable LLM response', async () => {
    globalThis.fetch = jest.fn(() => ({
      ok: true,
      status: 200,
      json: () => ({ choices: [{ message: { content: 'not json {{' } }] }),
    })) as unknown as typeof fetch;
    const fallback = new LLMFallback('sk-123');
    const result = await fallback.attemptFix(callSite, 'content', change, {});
    expect(result.success).toBe(false);
    expect(result.needsManualReview).toBe(true);
  });

  it('caches identical (file, line, change) requests', async () => {
    mockOpenAI({
      success: true,
      fixedCode: 'const uuid = response.user.uuid;',
      confidence: 90,
      explanation: 'renamed',
    });
    const fallback = new LLMFallback('sk-123');
    await fallback.attemptFix(callSite, 'content', change, {});
    await fallback.attemptFix(callSite, 'content', change, {});
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
