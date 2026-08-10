import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { BreakingChange } from '../../diff/engine';
import { GraphQLClientScanner } from '../scanner';

describe('GraphQLClientScanner', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-gql-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const fieldRemoval = (property: string): BreakingChange => ({
    type: 'field_removed',
    severity: 'breaking',
    schema: 'Payment',
    property,
    confidence: 100,
    message: `Payment.${property} removed`,
  });

  it('finds gql tagged templates that select a removed field (Apollo/urql)', async () => {
    const code = `import { gql } from '@urql/core';
const PaymentsQuery = gql\`
  query Payments {
    payments {
      id
      amount
      status
    }
  }
\`;
export { PaymentsQuery };
`;
    const file = join(testDir, 'payments.ts');
    writeFileSync(file, code);

    const scanner = new GraphQLClientScanner();
    const callSites = await scanner.findCallSites(testDir, [fieldRemoval('amount')]);

    expect(callSites).toHaveLength(1);
    expect(callSites[0]?.file).toContain('payments.ts');
    expect(callSites[0]?.matchText).toBe('amount');
    expect(callSites[0]?.line).toBeGreaterThanOrEqual(3);
  });

  it('finds Relay graphql fragments', async () => {
    const code = `import { graphql } from 'react-relay';
export const PaymentFragment = graphql\`
  fragment PaymentItem on Payment {
    id
    amount
  }
\`;
`;
    const file = join(testDir, 'fragment.ts');
    writeFileSync(file, code);

    const scanner = new GraphQLClientScanner();
    const callSites = await scanner.findCallSites(testDir, [fieldRemoval('amount')]);

    expect(callSites.some(s => s.file.endsWith('fragment.ts') && s.matchText === 'amount')).toBe(
      true,
    );
  });

  it('reports no call sites when the field is not selected', async () => {
    writeFileSync(join(testDir, 'safe.ts'), 'const Q = gql`{ payments { id status } }`;');

    const scanner = new GraphQLClientScanner();
    const callSites = await scanner.findCallSites(testDir, [fieldRemoval('amount')]);
    expect(callSites).toHaveLength(0);
  });

  it('returns nothing when there are no field changes to scan for', async () => {
    writeFileSync(join(testDir, 'a.ts'), 'const Q = gql`{ x { amount } }`;');
    const scanner = new GraphQLClientScanner();
    // Only an enum change but no enum appears in the doc — still exercises the path.
    const callSites = await scanner.findCallSites(testDir, [
      {
        type: 'enum_value_removed',
        severity: 'breaking',
        schema: 'S',
        property: 'NOPE',
        confidence: 100,
        message: 'x',
      },
    ]);
    expect(callSites).toHaveLength(0);
  });

  it('ignores node_modules', async () => {
    const nm = join(testDir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'lib.ts'), 'const Q = gql`{ payments { amount } }`;');
    writeFileSync(join(testDir, 'app.ts'), 'const Q = gql`{ payments { id } }`;');

    const scanner = new GraphQLClientScanner();
    const callSites = await scanner.findCallSites(testDir, [fieldRemoval('amount')]);
    expect(callSites).toHaveLength(0);
  });
});
