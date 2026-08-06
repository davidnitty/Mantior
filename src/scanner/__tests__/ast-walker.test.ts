import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BreakingChange } from '../../diff/engine';
import { ASTWalker } from '../ast-walker';

describe('ASTWalker', () => {
  const walker = new ASTWalker();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'mantior-test');
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('findCallSites()', () => {
    it('finds property access call sites', async () => {
      const code = [
        'const response = await api.createCharge({ amount: 100 });',
        'console.log(response.amount);',
        'const total = response.amount + 50;',
      ].join('\n');
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, code);

      const changes: BreakingChange[] = [
        {
          type: 'property_removed',
          property: 'amount',
          severity: 'breaking',
          confidence: 100,
          message: 'amount removed',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites).toHaveLength(2);
      expect(callSites[0]?.matchText).toContain('amount');
      expect(callSites[0]?.line).toBe(2);
    });

    it('finds destructured properties', async () => {
      const code = ['const { amount, currency } = response;', 'console.log(amount);'].join('\n');
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, code);

      const changes: BreakingChange[] = [
        {
          type: 'property_removed',
          property: 'amount',
          severity: 'breaking',
          confidence: 100,
          message: 'amount removed',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites).toHaveLength(1);
      expect(callSites[0]?.matchText).toBe('amount');
    });

    it('finds nested property access', async () => {
      const code = [
        'const userId = response.user.id;',
        'const userEmail = response.user.email;',
      ].join('\n');
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, code);

      const changes: BreakingChange[] = [
        {
          type: 'property_renamed',
          property: 'id',
          newProperty: 'uuid',
          severity: 'breaking',
          confidence: 100,
          message: 'id renamed to uuid',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites).toHaveLength(1);
      expect(callSites[0]?.matchText).toBe('response.user.id');
    });

    it('skips node_modules', async () => {
      const nodeModulesDir = join(testDir, 'node_modules');
      mkdirSync(nodeModulesDir, { recursive: true });
      writeFileSync(join(nodeModulesDir, 'test.ts'), 'const x = response.amount;');

      const changes: BreakingChange[] = [
        {
          type: 'property_removed',
          property: 'amount',
          severity: 'breaking',
          confidence: 100,
          message: 'amount removed',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites).toHaveLength(0);
    });

    it('finds schema type references and imports', async () => {
      const code = [
        "import { ChargeRequest } from './api-types';",
        'const request: ChargeRequest = { amount: 100 };',
      ].join('\n');
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, code);

      const changes: BreakingChange[] = [
        {
          type: 'schema_renamed',
          severity: 'breaking',
          oldValue: 'ChargeRequest',
          newValue: 'PaymentRequest',
          confidence: 80,
          message: 'Schema "ChargeRequest" renamed to "PaymentRequest".',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites.length).toBeGreaterThanOrEqual(1);
      expect(callSites.some(site => site.matchText.includes('ChargeRequest'))).toBe(true);
    });

    it('falls back to regex for unsupported languages', async () => {
      const filePath = join(testDir, 'client.go');
      writeFileSync(filePath, 'total := response.amount\n', 'utf8');

      const changes: BreakingChange[] = [
        {
          type: 'property_removed',
          property: 'amount',
          severity: 'breaking',
          confidence: 100,
          message: 'amount removed',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'go');

      expect(callSites).toHaveLength(1);
      expect(callSites[0]?.line).toBe(1);
    });

    it('finds spread operator usage', async () => {
      const filePath = join(testDir, 'test.ts');
      writeFileSync(filePath, 'const newCharge = { ...response, amount: 200 };\n', 'utf8');

      const changes: BreakingChange[] = [
        {
          type: 'property_removed',
          property: 'amount',
          severity: 'breaking',
          confidence: 100,
          message: 'amount removed',
        },
      ];
      const callSites = await walker.findCallSites(testDir, changes, 'typescript');

      expect(callSites.some(s => s.matchText.includes('amount'))).toBe(true);
    });
  });
});
