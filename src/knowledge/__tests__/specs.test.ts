import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { SpecRepository } from '../specs';

describe('SpecRepository', () => {
  const fixture = (name: string): string => join(process.cwd(), '__fixtures__', 'specs', name);

  it('loads YAML specs and lists endpoints', () => {
    const repo = new SpecRepository();
    const spec = repo.loadSpec(fixture('payment-api-v1.yaml'));

    expect(spec.name).toBe('Payment API');
    const endpoints = repo.getEndpoints(spec.id);
    expect(endpoints.some(e => e.path === '/v1/charges' && e.method === 'POST')).toBe(true);
  });

  it('diffs specs by endpoint', () => {
    const repo = new SpecRepository();
    const oldSpec = repo.loadSpec(fixture('payment-api-v1.yaml'));
    const newSpec = repo.loadSpec(fixture('payment-api-v2.yaml'));

    const diff = repo.compareSpecs(oldSpec.id, newSpec.id);
    expect(diff.removed).toContain('POST:/v1/charges');
    expect(diff.added).toContain('POST:/v2/payments');
  });
});
