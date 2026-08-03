import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Node } from 'ts-morph';

import { type BreakingChange } from '../diff/engine';
import { logger } from '../logger';

import { type CallSite } from './ast-walker';

const PYTHON_SCRIPT = `
import ast
import sys
import json

patterns = set(sys.argv[1].split(','))

def find_property_accesses(code):
    results = []
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return results

    class PropertyVisitor(ast.NodeVisitor):
        def visit_Attribute(self, node):
            if node.attr in patterns:
                results.append({
                    'line': node.lineno,
                    'col': node.col_offset,
                    'attr': node.attr,
                    'value': ast.unparse(node.value) if hasattr(ast, 'unparse') else '',
                })
            self.generic_visit(node)

        def visit_Assign(self, node):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    if target.id in patterns:
                        results.append({
                            'line': node.lineno,
                            'col': node.col_offset,
                            'attr': target.id,
                            'value': ast.unparse(node.value) if hasattr(ast, 'unparse') else '',
                        })
                elif isinstance(target, ast.Tuple):
                    for elt in target.elts:
                        if isinstance(elt, ast.Name) and elt.id in patterns:
                            results.append({
                                'line': node.lineno,
                                'col': node.col_offset,
                                'attr': elt.id,
                                'value': 'destructured',
                            })
            self.generic_visit(node)

    visitor = PropertyVisitor()
    visitor.visit(tree)
    return results

code = sys.stdin.read()
print(json.dumps(find_property_accesses(code)))
`;

const SKIP_DIRS = new Set([
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
  'node_modules',
  'dist',
  'build',
  '.git',
]);

/**
 * Python call-site detection using CPython's built-in `ast` module via a child
 * process. Discovery is done in pure Node so the walker is portable across
 * win32 and POSIX; Python only does the parsing (via stdin, no shell).
 */
export class PythonASTWalker {
  private pythonBinary: string | undefined;

  async findCallSites(repoPath: string, changes: BreakingChange[]): Promise<CallSite[]> {
    if (!this.pythonBinary) {
      this.pythonBinary = await this.locatePython();
    }
    if (!this.pythonBinary) {
      logger.warn('Python not found on PATH; skipping Python call-site scanning');
      return [];
    }

    const patterns = changes
      .filter(change => change.type === 'property_removed' || change.type === 'property_renamed')
      .map(change => change.property)
      .filter((property): property is string => property !== undefined && property.length > 0);

    if (patterns.length === 0) {
      return [];
    }

    const callSites: CallSite[] = [];
    for (const file of this.findPythonFiles(repoPath)) {
      const content = readFileSync(file, 'utf8');
      const matches = await this.parsePythonFile(file, content, patterns);
      for (const match of matches) {
        const change = changes.find(candidate => candidate.property === match.attr);
        if (!change) {
          continue;
        }
        const lines = content.split('\n');
        const startLine = Math.max(0, match.line - 4);
        const endLine = Math.min(lines.length, match.line + 3);
        callSites.push({
          file,
          line: match.line,
          column: match.col + 1,
          node: null as unknown as Node,
          change,
          matchText: match.value,
          context: {
            surroundingCode: lines.slice(startLine, endLine).join('\n'),
            parentFunction: this.getParentFunctionPython(content, match.line),
            variableName: match.value.split('.')[0] ?? '',
            objectChain: match.value.split('.'),
          },
        });
      }
    }
    return callSites;
  }

  // ──────────────────────────────────────────────
  // FILE DISCOVERY (pure Node, portable)
  // ──────────────────────────────────────────────

  private findPythonFiles(repoPath: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(full);
          }
        } else if (entry.isFile() && entry.name.endsWith('.py') && !entry.name.startsWith('.')) {
          files.push(full);
        }
      }
    };
    walk(repoPath);
    files.sort();
    return files;
  }

  // ──────────────────────────────────────────────
  // PYTHON PROCESS
  // ──────────────────────────────────────────────

  private locatePython(): Promise<string | undefined> {
    const candidates = ['python3', 'python', 'py'];
    return new Promise(resolvePromise => {
      let index = 0;
      const tryNext = (): void => {
        const candidate = candidates[index++];
        if (!candidate) {
          resolvePromise(undefined);
          return;
        }
        execFile(candidate, ['--version'], { timeout: 10_000 }, error => {
          if (!error) {
            resolvePromise(candidate);
          } else {
            tryNext();
          }
        });
      };
      tryNext();
    });
  }

  private parsePythonFile(
    file: string,
    content: string,
    patterns: string[],
  ): Promise<Array<{ line: number; col: number; attr: string; value: string }>> {
    return new Promise((resolvePromise, rejectPromise) => {
      const python = this.pythonBinary;
      if (!python) {
        resolvePromise([]);
        return;
      }
      const child = execFile(
        python,
        ['-c', PYTHON_SCRIPT, patterns.join(',')],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            logger.debug(
              { file, error: String(stderr ?? '').slice(0, 200) },
              'Failed to parse Python file',
            );
            resolvePromise([]);
            return;
          }
          try {
            resolvePromise(
              JSON.parse(String(stdout)) as Array<{
                line: number;
                col: number;
                attr: string;
                value: string;
              }>,
            );
          } catch (parseError) {
            logger.debug({ file, error: parseError }, 'Failed to decode Python walker output');
            resolvePromise([]);
          }
        },
      );
      child.stdin?.end(content, 'utf8');
      child.stdin?.on('error', rejectPromise);
    });
  }

  // ──────────────────────────────────────────────
  // CONTEXT
  // ──────────────────────────────────────────────

  private getParentFunctionPython(content: string, line: number): string | undefined {
    const lines = content.split('\n');
    for (let i = line - 1; i >= 0; i--) {
      const text = lines[i] ?? '';
      const match = /^\s*def\s+(\w+)\s*\(/.exec(text);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }
}

/** Test helper: is a usable Python interpreter present on PATH? */
export async function pythonAvailable(): Promise<boolean> {
  const candidates = ['python3', 'python', 'py'];
  for (const candidate of candidates) {
    try {
      await runVersionCheck(candidate);
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function runVersionCheck(candidate: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(candidate, ['--version'], { timeout: 10_000, windowsHide: true }, error => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}
