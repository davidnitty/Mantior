import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MantiorConfig } from '../../config/loader';
import type { BreakingChange } from '../../diff/engine';
import type { CallSite } from '../../scanner/ast-walker';
import { DeterministicFixer, FixComplexity } from '../deterministic';

describe('DeterministicFixer', () => {
  const fixer = new DeterministicFixer();

  const config: MantiorConfig = {
    api: {
      name: 'Payment API',
      spec: 'v2.yaml',
      reference_url: 'https://example.com/v1/openapi.json',
    },
    consumers: [],
    security: {},
    rules: { auto_pr: true, pr_labels: [] },
    mappings: [{ old_path: 'response.body.amount', new_path: 'response.body.amount_cents' }],
    notifications: {},
  };

  describe('scoreChangeComplexity', () => {
    it('classifies simple renames as LOW', () => {
      const change = {
        type: 'property_renamed',
        property: 'amount',
        newProperty: 'amount_cents',
        message: 'x',
      } as BreakingChange;
      expect(fixer.scoreChangeComplexity(change)).toBe(FixComplexity.LOW);
    });

    it('classifies semantic renames as MEDIUM', () => {
      const change = {
        type: 'property_renamed',
        property: 'name',
        newProperty: 'full_name',
        message: 'x',
      } as BreakingChange;
      expect(fixer.scoreChangeComplexity(change)).toBe(FixComplexity.MEDIUM);
    });

    it('classifies complex renames as HIGH', () => {
      const change = {
        type: 'property_renamed',
        property: 'created_at',
        newProperty: 'iso_timestamp',
        message: 'x',
      } as BreakingChange;
      expect(fixer.scoreChangeComplexity(change)).toBe(FixComplexity.HIGH);
    });

    it('classifies endpoint removal without replacement as AMBIGUOUS', () => {
      const change = {
        type: 'endpoint_removed',
        path: '/v1/charges',
        message: 'removed',
      } as BreakingChange;
      expect(fixer.scoreChangeComplexity(change)).toBe(FixComplexity.AMBIGUOUS);
    });
  });

  describe('applyFixes', () => {
    it('applies mapping-based deterministic renames', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'mantior-fixer-'));
      const filePath = join(testDir, 'payment.ts');
      writeFileSync(
        filePath,
        'const response = { amount: 100 };\nconst total = response.amount;\n',
        'utf8',
      );

      try {
        const change = {
          type: 'property_renamed',
          property: 'amount',
          newProperty: 'amount_cents',
          severity: 'breaking',
          message: 'renamed',
        } as BreakingChange;
        const callSite: CallSite = {
          file: filePath,
          line: 2,
          column: 11,
          node: null,
          change,
          matchText: 'response.amount',
          context: {
            surroundingCode: 'const total = response.amount;',
            objectChain: ['response', 'amount'],
          },
        };

        const outcome = await fixer.applyFixes([callSite], config, [change]);

        expect(outcome.fixedFiles[filePath]).toContain('amount_cents');
        expect(outcome.manualInterventions).toHaveLength(0);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('routes unfixable changes to manual interventions', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'mantior-fixer-'));
      const filePath = join(testDir, 'payment.ts');
      writeFileSync(filePath, 'const total = response.user_id;\n', 'utf8');

      try {
        const change = {
          type: 'property_removed',
          property: 'user_id',
          severity: 'breaking',
          message: 'user_id removed',
        } as BreakingChange;
        const callSite: CallSite = {
          file: filePath,
          line: 1,
          column: 11,
          node: null,
          change,
          matchText: 'response.user_id',
          context: {
            surroundingCode: 'const total = response.user_id;',
            objectChain: ['response', 'user_id'],
          },
        };

        const outcome = await fixer.applyFixes([callSite], config, [change]);

        expect(Object.keys(outcome.fixedFiles)).toHaveLength(0);
        expect(outcome.manualInterventions).toHaveLength(1);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
