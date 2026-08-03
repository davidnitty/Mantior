import { readFileSync } from 'node:fs';

import { glob } from 'glob';
import {
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type ObjectLiteralExpression,
  Project,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type SourceFile,
  type SpreadAssignment,
  SyntaxKind,
  type VariableDeclaration,
} from 'ts-morph';

import { type BreakingChange } from '../diff/engine';
import { logger } from '../logger';

import { PythonASTWalker } from './ast-walker-python';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export interface CallSite {
  file: string;
  line: number;
  column: number;
  node: Node | null;
  change: BreakingChange;
  matchText: string;
  context: {
    surroundingCode: string;
    parentFunction?: string;
    variableName?: string;
    objectChain: string[];
  };
}

export interface ApiClientPattern {
  clientVariableNames: string[];
  importPaths: string[];
}

interface ApiClient {
  variableName: string;
  importPath: string;
}

const RESPONSE_PATTERNS = ['response', 'data', 'result', 'payload', 'body'];
const HTTP_PATTERNS = ['get', 'post', 'put', 'delete', 'patch', 'request'];

// ──────────────────────────────────────────────
// AST WALKER
// ──────────────────────────────────────────────

/**
 * Locates call sites of changed properties in consumer code. TypeScript/JS get
 * a full ts-morph AST walk; Python gets its own ast-module walker; all other
 * languages fall back to deterministic line-aware regex matching.
 */
export class ASTWalker {
  private readonly pythonWalker = new PythonASTWalker();

  findCallSites(
    repoPath: string,
    changes: BreakingChange[],
    language: string,
  ): Promise<CallSite[]> {
    logger.debug({ repoPath, language, changeCount: changes.length }, 'Finding call sites');

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.findCallSitesTypeScript(repoPath, changes);
      case 'python':
        return this.pythonWalker.findCallSites(repoPath, changes);
      default:
        logger.warn({ language }, 'Language not supported, using regex fallback');
        return this.regexFallback(repoPath, changes);
    }
  }

  // ──────────────────────────────────────────────
  // TYPESCRIPT / JAVASCRIPT
  // ──────────────────────────────────────────────

  private async findCallSitesTypeScript(
    repoPath: string,
    changes: BreakingChange[],
  ): Promise<CallSite[]> {
    const files = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: repoPath,
      ignore: [
        'node_modules/**',
        'dist/**',
        'build/**',
        'coverage/**',
        '**/*.test.*',
        '**/*.spec.*',
        '.git/**',
      ],
      absolute: true,
    });

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sourceFiles = files
      .map(file => {
        try {
          return project.addSourceFileAtPath(file);
        } catch (error) {
          logger.debug({ file, error }, 'Failed to add source file');
          return undefined;
        }
      })
      .filter(
        (sourceFile): sourceFile is NonNullable<typeof sourceFile> => sourceFile !== undefined,
      );

    const apiClients = this.findApiClients(sourceFiles);

    const callSites: CallSite[] = [];
    for (const change of changes) {
      if (change.type === 'property_removed' || change.type === 'property_renamed') {
        const propName = change.property ?? '';
        const patterns = this.buildSearchPatterns(propName, change.schema);
        for (const sourceFile of sourceFiles) {
          callSites.push(...this.searchInFile(sourceFile, change, patterns, apiClients));
        }
      }
      if (change.type === 'schema_renamed') {
        const oldSchema = change.oldValue ?? '';
        for (const sourceFile of sourceFiles) {
          callSites.push(...this.findSchemaReferences(sourceFile, oldSchema));
        }
      }
    }

    return this.deduplicateCallSites(callSites);
  }

  private findApiClients(sourceFiles: SourceFile[]): ApiClient[] {
    const clients: ApiClient[] = [];
    for (const sourceFile of sourceFiles) {
      for (const importDeclaration of sourceFile.getImportDeclarations()) {
        const importPath = importDeclaration.getModuleSpecifierValue();
        if (DEFAULT_IMPORT_PATHS.some(candidate => importPath.includes(candidate))) {
          for (const namedImport of importDeclaration.getNamedImports()) {
            clients.push({ variableName: namedImport.getName(), importPath });
          }
        }
      }
      for (const variableDeclaration of sourceFile.getVariableDeclarations()) {
        const name = variableDeclaration.getName();
        if (
          name !== undefined &&
          DEFAULT_CLIENT_VARIABLES.some(candidate => name.toLowerCase().includes(candidate))
        ) {
          clients.push({ variableName: name, importPath: 'unknown' });
        }
      }
    }
    return clients;
  }

  private searchInFile(
    sourceFile: SourceFile,
    change: BreakingChange,
    patterns: string[],
    apiClients: ApiClient[],
  ): CallSite[] {
    const callSites: CallSite[] = [];

    for (const node of sourceFile.getDescendants()) {
      // Property access: response.amount
      if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = node as PropertyAccessExpression;
        if (patterns.includes(propAccess.getName())) {
          const chain = this.getPropertyChain(propAccess);
          if (this.isLikelyApiAccess(chain, apiClients)) {
            callSites.push(this.createCallSite(propAccess, change, chain));
          }
        }
      }

      // Destructuring: const { amount } = response  |  const { amount } = { amount }
      if (node.getKind() === SyntaxKind.VariableDeclaration) {
        callSites.push(
          ...this.findDestructuredCallSites(node as VariableDeclaration, change, patterns),
        );
      }

      // Spread/rest: { ...response, amount: 100 }
      if (node.getKind() === SyntaxKind.SpreadAssignment) {
        const spread = node as SpreadAssignment;
        const expression = spread.getExpression();
        if (expression.getKind() === SyntaxKind.Identifier) {
          const name = (expression as Identifier).getText();
          if (patterns.includes(name) && this.isLikelyApiAccess([name], apiClients)) {
            callSites.push(this.createCallSite(spread, change, [name]));
          }
        }
      }
    }

    return callSites;
  }

  private findDestructuredCallSites(
    variableDeclaration: VariableDeclaration,
    change: BreakingChange,
    patterns: string[],
  ): CallSite[] {
    const callSites: CallSite[] = [];
    const declarationName = variableDeclaration.getNameNode();
    const initializer = variableDeclaration.getInitializer();

    if (declarationName.getKind() === SyntaxKind.ObjectBindingPattern) {
      // const { amount, currency } = response
      const isApiSource =
        initializer !== undefined &&
        initializer.getKind() === SyntaxKind.Identifier &&
        isLikelyResponseName((initializer as Identifier).getText());
      if (isApiSource) {
        for (const element of declarationName.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          const propertyNameNode = element.getPropertyNameNode();
          const propertyName = propertyNameNode ? propertyNameNode.getText() : element.getName();
          if (patterns.includes(propertyName)) {
            callSites.push(this.createCallSite(element, change, [propertyName], propertyName));
          }
        }
      }
    } else if (declarationName.getKind() === SyntaxKind.Identifier && initializer !== undefined) {
      // const x = { amount: 1 }
      if (initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objectLiteral = initializer as ObjectLiteralExpression;
        const pattern = new Set(patterns);
        for (const property of objectLiteral.getProperties()) {
          if (property.getKind() === SyntaxKind.PropertyAssignment) {
            const assignment = property as PropertyAssignment;
            if (pattern.has(assignment.getName())) {
              callSites.push(
                this.createCallSite(
                  assignment,
                  change,
                  [assignment.getName()],
                  assignment.getName(),
                ),
              );
            }
          }
        }
      }
    }

    return callSites;
  }

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────

  private getPropertyChain(node: PropertyAccessExpression): string[] {
    const chain: string[] = [];
    let current: Node | undefined = node;
    while (current !== undefined && current.getKind() === SyntaxKind.PropertyAccessExpression) {
      chain.unshift((current as PropertyAccessExpression).getName());
      current = (current as PropertyAccessExpression).getExpression();
    }
    if (current !== undefined && current.getKind() === SyntaxKind.Identifier) {
      chain.unshift((current as Identifier).getText());
    }
    return chain;
  }

  private isLikelyApiAccess(chain: string[], apiClients: ApiClient[]): boolean {
    const first = chain[0] ?? '';
    if (apiClients.some(client => client.variableName === first)) {
      return true;
    }
    if (RESPONSE_PATTERNS.some(pattern => chain.includes(pattern))) {
      return true;
    }
    return HTTP_PATTERNS.some(pattern => chain.includes(pattern));
  }

  private createCallSite(
    node: Node,
    change: BreakingChange,
    chain: string[],
    matchText?: string,
  ): CallSite {
    const sourceFile = node.getSourceFile();
    const fullText = sourceFile.getFullText();
    const position = node.getStart();
    const lineStart = fullText.lastIndexOf('\n', position - 1) + 1;
    return {
      file: sourceFile.getFilePath(),
      line: node.getStartLineNumber(),
      column: position - lineStart + 1,
      node,
      change,
      matchText: matchText ?? chain.join('.'),
      context: {
        surroundingCode: this.getSurroundingCode(node),
        parentFunction: this.getParentFunctionName(node),
        variableName: this.getVariableName(node),
        objectChain: chain,
      },
    };
  }

  private getSurroundingCode(node: Node): string {
    const fullText = node.getSourceFile().getText();
    const start = Math.max(0, node.getStart() - 200);
    const end = Math.min(fullText.length, node.getEnd() + 200);
    let context = fullText.slice(start, end);
    if (start > 0) {
      context = `...${context}`;
    }
    if (end < fullText.length) {
      context = `${context}...`;
    }
    return context;
  }

  private getParentFunctionName(node: Node): string | undefined {
    let parent = node.getParent();
    while (parent !== undefined) {
      if (parent.getKind() === SyntaxKind.FunctionDeclaration) {
        return (parent as FunctionDeclaration).getName() ?? 'anonymous-function';
      }
      if (parent.getKind() === SyntaxKind.ArrowFunction) {
        const arrowParent = parent.getParent();
        if (arrowParent?.getKind() === SyntaxKind.VariableDeclaration) {
          return (arrowParent as VariableDeclaration).getName();
        }
        return 'arrow-function';
      }
      if (parent.getKind() === SyntaxKind.MethodDeclaration) {
        return 'method';
      }
      parent = parent.getParent();
    }
    return undefined;
  }

  private getVariableName(node: Node): string | undefined {
    let current: Node | undefined = node;
    while (current !== undefined) {
      if (current.getKind() === SyntaxKind.VariableDeclaration) {
        return (current as VariableDeclaration).getName();
      }
      if (current.getKind() === SyntaxKind.Identifier) {
        return (current as Identifier).getText();
      }
      current = current.getParent();
    }
    return undefined;
  }

  private buildSearchPatterns(propName: string, schemaName?: string): string[] {
    const patterns = [propName, propName.toLowerCase(), propName.toUpperCase()];
    patterns.push(propName.charAt(0).toUpperCase() + propName.slice(1));
    if (schemaName) {
      patterns.push(`${schemaName}.${propName}`);
      patterns.push(`${schemaName.toLowerCase()}.${propName}`);
    }
    return patterns;
  }

  private findSchemaReferences(sourceFile: SourceFile, schemaName: string): CallSite[] {
    const callSites: CallSite[] = [];
    const change: BreakingChange = {
      type: 'schema_renamed',
      severity: 'breaking',
      oldValue: schemaName,
      message: `Schema reference to "${schemaName}" found`,
      confidence: 100,
    };

    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      const typeReference = node;
      const typeName = typeReference.getTypeName();
      if (
        typeName.getKind() === SyntaxKind.Identifier &&
        (typeName as Identifier).getText() === schemaName
      ) {
        callSites.push(this.createCallSite(typeReference, change, [schemaName], schemaName));
      }
    }

    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      for (const namedImport of importDeclaration.getNamedImports()) {
        if (namedImport.getName() === schemaName) {
          callSites.push(
            this.createCallSite(
              importDeclaration,
              change,
              [schemaName],
              `import { ${schemaName} }`,
            ),
          );
        }
      }
    }

    return callSites;
  }

  private deduplicateCallSites(callSites: CallSite[]): CallSite[] {
    const unique = new Map<string, CallSite>();
    for (const site of callSites) {
      const key = `${site.file}:${site.line}:${site.matchText}`;
      if (!unique.has(key)) {
        unique.set(key, site);
      }
    }
    return [...unique.values()];
  }

  // ──────────────────────────────────────────────
  // REGEX FALLBACK (unsupported languages)
  // ──────────────────────────────────────────────

  async regexFallback(repoPath: string, changes: BreakingChange[]): Promise<CallSite[]> {
    const callSites: CallSite[] = [];
    const propertyChanges = changes.filter(
      change => change.type === 'property_removed' || change.type === 'property_renamed',
    );
    const properties = propertyChanges
      .map(change => change.property)
      .filter((property): property is string => property !== undefined && property.length > 0);

    if (properties.length === 0) {
      return callSites;
    }

    const files = await glob('**/*.{ts,tsx,js,jsx,py,go,java,rb}', {
      cwd: repoPath,
      ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**', '**/venv/**'],
      absolute: true,
    });

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const property of properties) {
          // Fresh (non-global) pattern per property per line — avoids the
          // stateful lastIndex bug of shared /g regexes.
          const pattern = new RegExp(`\\b${escapeRegExp(property)}\\b`);
          if (pattern.test(line)) {
            const change = propertyChanges.find(candidate => candidate.property === property);
            if (change) {
              callSites.push({
                file,
                line: i + 1,
                column: 0,
                node: null,
                change,
                matchText: line.trim(),
                context: { surroundingCode: line, objectChain: [] },
              });
            }
          }
        }
      }
    }

    return callSites;
  }
}

function isLikelyResponseName(name: string): boolean {
  return (
    RESPONSE_PATTERNS.includes(name) ||
    HTTP_PATTERNS.includes(name) ||
    name.includes('response') ||
    name.includes('api')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_CLIENT_VARIABLES = ['api', 'client', 'sdk', 'service', 'axios', 'fetch'];
const DEFAULT_IMPORT_PATHS = ['@/api', '@/services', '@/lib/api', './api', './services'];
