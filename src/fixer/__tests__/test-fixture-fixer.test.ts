import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Project, type SourceFile } from 'ts-morph';

import type { BreakingChange } from '../../diff/engine';
import { TestFixtureFixer, applyTestFixtureFixes } from '../test-fixture-fixer';

describe('TestFixtureFixer', () => {
  const fixer = new TestFixtureFixer();

  const createFile = (code: string): SourceFile => {
    const project = new Project({ useInMemoryFileSystem: true });
    return project.createSourceFile('test.ts', code);
  };

  it('renames matching mocks and assertions in a context file', () => {
    const file = createFile(`
interface User { email: string }
declare function getUser(): User;
const mockUser: User = { email: 'a@a.com' };
const user: User = getUser();
expect(user.email).toBe('a@a.com');
`);

    const result = fixer.applyFieldRename(file, 'email', 'emailAddress', 'User');

    expect(result.mocksUpdated).toBe(1);
    expect(result.assertionsUpdated).toBe(1);
    expect(file.getText()).toContain("{ emailAddress: 'a@a.com' }");
    expect(file.getText()).toContain('user.emailAddress');
  });

  it('does not rename a mock for an unrelated type', () => {
    const file = createFile(`
interface User { email: string }
interface BillingInfo { email: string }
const mockUser: User = { email: 'a@a.com' };
const billing: BillingInfo = { email: 'b@b.com' };
`);

    const result = fixer.applyFieldRename(file, 'email', 'emailAddress', 'User');

    expect(result.mocksUpdated).toBe(1);
    expect(file.getText()).toContain("mockUser: User = { emailAddress: 'a@a.com' }");
    expect(file.getText()).toContain("billing: BillingInfo = { email: 'b@b.com' }");
  });

  it('does not rename an assertion on an unrelated type', () => {
    const file = createFile(`
interface User { email: string }
interface BillingInfo { email: string }
declare function getUser(): User;
declare function getBilling(): BillingInfo;
const user: User = getUser();
const billing: BillingInfo = getBilling();
expect(user.email).toBe('x');
expect(billing.email).toBe('y');
`);

    const result = fixer.applyFieldRename(file, 'email', 'emailAddress', 'User');

    expect(result.assertionsUpdated).toBe(1);
    expect(file.getText()).toContain('user.emailAddress');
    expect(file.getText()).toContain('billing.email');
  });

  it('skips files with no reference to the target type', () => {
    const file = createFile(`
interface BillingInfo { email: string }
const billing: BillingInfo = { email: 'b@b.com' };
`);

    const result = fixer.applyFieldRename(file, 'email', 'emailAddress', 'User');

    expect(result).toMatchObject({ mocksUpdated: 0, assertionsUpdated: 0 });
    expect(result.file).toContain('test.ts');
  });

  it('recognizes `as User` assertion mocks', () => {
    const file = createFile(`
interface User { email: string }
const mockUser = { email: 'a@a.com' } as User;
`);

    const result = fixer.applyFieldRename(file, 'email', 'emailAddress', 'User');

    expect(result.mocksUpdated).toBe(1);
    expect(file.getText()).toContain('emailAddress');
  });

  it('returns zero updates when the field name does not match', () => {
    const file = createFile(`
interface User { email: string }
const mockUser: User = { email: 'a@a.com' };
`);

    const result = fixer.applyFieldRename(file, 'name', 'fullName', 'User');

    expect(result).toMatchObject({ mocksUpdated: 0, assertionsUpdated: 0 });
    expect(result.file).toContain('test.ts');
  });
});

describe('applyTestFixtureFixes', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-fixtures-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const renameChange: BreakingChange = {
    type: 'property_renamed',
    severity: 'breaking',
    schema: 'User',
    property: 'email',
    newProperty: 'emailAddress',
    message: 'Property "email" renamed to "emailAddress".',
    confidence: 100,
  };

  it('updates matching test fixtures and leaves unrelated types untouched', () => {
    writeFileSync(join(testDir, 'user.ts'), 'export interface User { email: string }\n');
    writeFileSync(join(testDir, 'billing.ts'), 'export interface BillingInfo { email: string }\n');
    writeFileSync(
      join(testDir, 'getUser.test.ts'),
      [
        "import { User } from './user';",
        "import { BillingInfo } from './billing';",
        "const mockUser: User = { email: 'a@a.com' };",
        "const billing: BillingInfo = { email: 'b@b.com' };",
        "expect(mockUser.email).toBe('a@a.com');",
      ].join('\n'),
    );

    const run = applyTestFixtureFixes(testDir, [renameChange]);

    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.mocksUpdated).toBe(1);
    expect(run.results[0]?.assertionsUpdated).toBe(1);

    const fixedText = Object.values(run.fixedFiles)[0] ?? '';
    expect(fixedText).toContain("const mockUser: User = { emailAddress: 'a@a.com' };");
    expect(fixedText).toContain('mockUser.emailAddress');
    // Collateral damage prevention: the BillingInfo mock is untouched.
    expect(fixedText).toContain("const billing: BillingInfo = { email: 'b@b.com' };");
  });

  it('returns no results when there are no rename changes', () => {
    writeFileSync(join(testDir, 'a.test.ts'), "const x = { email: 'x' };\n");

    const run = applyTestFixtureFixes(testDir, [
      {
        type: 'field_removed',
        severity: 'breaking',
        property: 'email',
        message: 'email removed',
        confidence: 100,
      },
    ]);

    expect(run.results).toHaveLength(0);
    expect(Object.keys(run.fixedFiles)).toHaveLength(0);
  });

  it('skips node_modules', () => {
    const nm = join(testDir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'lib.test.ts'), "const mock: User = { email: 'x' };\n");
    writeFileSync(join(testDir, 'user.ts'), 'export interface User { email: string }\n');

    const run = applyTestFixtureFixes(testDir, [renameChange]);

    expect(run.results).toHaveLength(0);
  });
});
