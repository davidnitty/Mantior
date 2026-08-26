import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  Project,
  SyntaxKind,
  type Node,
  type PropertyAssignment,
  type SourceFile,
  type Type,
} from 'ts-morph';

import type { BreakingChange } from '../diff/engine';

export interface TestFixResult {
  file: string;
  mocksUpdated: number;
  assertionsUpdated: number;
}

export interface TestFixtureRunResult {
  results: TestFixResult[];
  /** Absolute path → updated file text, ready to merge into the PR's fixedFiles. */
  fixedFiles: Record<string, string>;
}

/**
 * Type-aware test fixture fixer. Renames a field (e.g. `email` → `emailAddress`)
 * in test mocks and assertions WITHOUT collateral damage: a property is only
 * renamed when the file references the changed type AND the property belongs
 * to an object/expression the compiler infers as that type. This prevents a
 * naive rename from touching an unrelated `BillingInfo.email` mock.
 */
export class TestFixtureFixer {
  /**
   * Apply a field rename to a test file. Returns the number of mock and
   * assertion sites that were actually updated.
   */
  applyFieldRename(
    testFile: SourceFile,
    oldFieldName: string,
    newFieldName: string,
    targetTypeName: string,
  ): TestFixResult {
    let mocksUpdated = 0;
    let assertionsUpdated = 0;

    // SAFETY CHECK: does this file even care about the changed type?
    if (!this.fileHasContext(testFile, targetTypeName)) {
      return { file: testFile.getFilePath(), mocksUpdated: 0, assertionsUpdated: 0 };
    }

    // 1. FIX MOCKS (object literals): only when the literal's enclosing
    //    declaration is typed as the target type.
    for (const prop of testFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (prop.getName() === oldFieldName && this.isTargetType(prop, targetTypeName)) {
        // Local rename only — `rename()` is a language-service (symbol-wide)
        // rename and would rewrite unrelated references.
        prop.getNameNode().replaceWithText(newFieldName);
        mocksUpdated++;
      }
    }

    // 2. FIX ASSERTIONS (property access): only when the accessed expression
    //    is typed as the target type.
    for (const access of testFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (
        access.getName() === oldFieldName &&
        this.typeMatches(access.getExpression().getType(), targetTypeName)
      ) {
        access.getNameNode().replaceWithText(newFieldName);
        assertionsUpdated++;
      }
    }

    return { file: testFile.getFilePath(), mocksUpdated, assertionsUpdated };
  }

  /**
   * Checks whether the file imports the target type or references it anywhere
   * (a coarse but cheap pre-filter before doing any type analysis).
   */
  private fileHasContext(file: SourceFile, targetTypeName: string): boolean {
    for (const importDeclaration of file.getImportDeclarations()) {
      if (importDeclaration.getNamedImports().some(named => named.getName() === targetTypeName)) {
        return true;
      }
    }
    return file.getFullText().includes(targetTypeName);
  }

  /**
   * Checks whether a PropertyAssignment belongs to an object typed as the
   * target type (e.g. `const mockUser: User = { email: '...' }`).
   */
  private isTargetType(prop: PropertyAssignment, targetTypeName: string): boolean {
    const objectLiteral = prop.getFirstAncestorByKind(SyntaxKind.ObjectLiteralExpression);
    if (!objectLiteral) {
      return false;
    }

    // 1. Enclosing variable's explicit type annotation — deterministic.
    //    `objectLiteral.getType()` returns the anonymous `{ email: string }`,
    //    so the annotation is the reliable signal here.
    const variable = objectLiteral.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const annotation = variable?.getTypeNode();
    if (annotation && annotation.getText() === targetTypeName) {
      return true;
    }

    // 2. Assertion patterns: `{...} as User` / `{...} satisfies User`.
    const assertedName = assertedTypeName(objectLiteral);
    if (assertedName === targetTypeName) {
      return true;
    }

    // 3. Fallback: type-checker (generics / contextual typing).
    return this.typeMatches(objectLiteral.getType(), targetTypeName);
  }

  private typeMatches(type: Type, targetTypeName: string): boolean {
    // 1. Explicit symbol name (e.g. interface User).
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    if (symbol && symbol.getName() === targetTypeName) {
      return true;
    }

    // 2. Structural fallback: inferred type text mentions the target
    //    (e.g. `User[]`, `Promise<User>`).
    return type.getText().includes(targetTypeName);
  }
}

/** Return the asserted type name for `x as T` / `x satisfies T` ancestors. */
function assertedTypeName(node: Node): string | undefined {
  let current: Node | undefined = node.getParent();
  while (current) {
    const kind = current.getKind();
    if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.SatisfiesExpression) {
      return (current as unknown as { getTypeNode(): Node | undefined }).getTypeNode()?.getText();
    }
    current = current.getParent();
  }
  return undefined;
}

// ──────────────────────────────────────────────
// REPO-LEVEL RUNNER
// ──────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', '.git', 'dist', 'build', '.next']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);

type RenameChange = BreakingChange & { property: string; newProperty: string; schema: string };

/**
 * Discover a cloned repo's source + test files, apply field renames to the
 * test files, and return the modified contents plus a per-file summary. Loads
 * the whole repo so imported types resolve for the type-aware checks.
 */
export function applyTestFixtureFixes(
  repoDir: string,
  changes: readonly BreakingChange[],
): TestFixtureRunResult {
  const renames = changes.filter((change): change is RenameChange => {
    return (
      change.type === 'property_renamed' &&
      typeof change.property === 'string' &&
      typeof change.newProperty === 'string' &&
      typeof change.schema === 'string'
    );
  });
  if (renames.length === 0) {
    return { results: [], fixedFiles: {} };
  }

  const files = listCodeFiles(repoDir);
  if (files.length === 0) {
    return { results: [], fixedFiles: {} };
  }

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // Skip files the parser can't handle rather than failing the whole run.
    }
  }

  const fixer = new TestFixtureFixer();
  const results: TestFixResult[] = [];
  const fixedFiles: Record<string, string> = {};

  for (const sourceFile of project.getSourceFiles()) {
    const path = sourceFile.getFilePath();
    if (!isTestFile(path)) {
      continue;
    }

    let mocksUpdated = 0;
    let assertionsUpdated = 0;
    for (const change of renames) {
      const result = fixer.applyFieldRename(
        sourceFile,
        change.property,
        change.newProperty,
        change.schema,
      );
      mocksUpdated += result.mocksUpdated;
      assertionsUpdated += result.assertionsUpdated;
    }

    if (mocksUpdated > 0 || assertionsUpdated > 0) {
      results.push({ file: path, mocksUpdated, assertionsUpdated });
      fixedFiles[path] = sourceFile.getFullText();
    }
  }

  return { results, fixedFiles };
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.test.ts') ||
    lower.endsWith('.test.tsx') ||
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.spec.tsx') ||
    lower.includes('/__tests__/') ||
    lower.includes('\\__tests__\\') ||
    lower.includes('/__mocks__/') ||
    lower.includes('\\__mocks__\\')
  );
}

function listCodeFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) {
        continue;
      }
      const full = join(current, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(extension(full))) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

function extension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot) : '';
}
