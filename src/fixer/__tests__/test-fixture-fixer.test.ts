import { describe, expect, it } from '@jest/globals';
import { Project, type SourceFile } from 'ts-morph';

import { TestFixtureFixer } from '../test-fixture-fixer';

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
