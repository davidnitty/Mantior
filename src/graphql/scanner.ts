import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type DocumentNode, Kind, type SelectionSetNode, parse } from 'graphql';
import {
  type Node,
  type NoSubstitutionTemplateLiteral,
  Project,
  type SourceFile,
  SyntaxKind,
  type TaggedTemplateExpression,
} from 'ts-morph';

import { type BreakingChange } from '../diff/engine';
import { type CallSite } from '../scanner/ast-walker';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const TAG_NAMES = new Set(['gql', 'graphql']);
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', '.git', 'dist', 'build', '.next']);

const FIELD_CHANGE_TYPES = new Set([
  'field_removed',
  'field_type_changed',
  'field_deprecated',
  'property_renamed',
]);

/**
 * Locates GraphQL client usage that would break under a schema change
 * (Apollo, urql, Relay: `gql`/`graphql` tagged templates). For each changed
 * field, reports any gql document in the consumer code that selects it, so
 * the fixer/PR layer can target the right place.
 */
export class GraphQLClientScanner {
  findCallSites(dir: string, changes: BreakingChange[]): Promise<CallSite[]> {
    return Promise.resolve(this.performScan(dir, changes));
  }

  private performScan(dir: string, changes: BreakingChange[]): CallSite[] {
    const fieldChanges = changes.filter(change => FIELD_CHANGE_TYPES.has(change.type));
    const enumChanges = changes.filter(change => change.type === 'enum_value_removed');
    if (fieldChanges.length === 0 && enumChanges.length === 0) {
      return [];
    }

    const callSites: CallSite[] = [];
    const project = new Project({ skipAddingFilesFromTsConfig: true });

    for (const file of this.listCodeFiles(dir)) {
      let sourceFile: SourceFile | undefined;
      try {
        sourceFile = project.addSourceFileAtPath(file);
      } catch {
        continue;
      }
      for (const template of sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
        if (!TAG_NAMES.has(tagBaseName(template))) {
          continue;
        }
        const templateNode = template.getTemplate() as NoSubstitutionTemplateLiteral;
        const sdl = templateNode.getLiteralText();
        let document: DocumentNode;
        try {
          document = parse(sdl);
        } catch {
          continue; // Not a GraphQL document (or malformed) — skip.
        }

        const selectedFields = collectSelectedFields(document);
        for (const change of fieldChanges) {
          if (change.property && selectedFields.has(change.property)) {
            callSites.push(
              this.buildCallSite(template, change, file, templateNode.getStartLineNumber()),
            );
          }
        }
        for (const change of enumChanges) {
          if (change.property && enumValueSelected(sdl, change.property)) {
            callSites.push(
              this.buildCallSite(template, change, file, templateNode.getStartLineNumber()),
            );
          }
        }
      }
    }

    return this.deduplicate(callSites);
  }

  private buildCallSite(
    node: TaggedTemplateExpression,
    change: BreakingChange,
    file: string,
    templateLine: number,
  ): CallSite {
    const sdl = (node.getTemplate() as NoSubstitutionTemplateLiteral).getLiteralText();
    const matchIndex = sdl.indexOf(change.property ?? '');
    const withinLine = matchIndex >= 0 ? countNewlines(sdl.slice(0, matchIndex)) : 0;
    return {
      file,
      line: templateLine + withinLine,
      column: 0,
      node: node as unknown as Node,
      change,
      matchText: change.property ?? '',
      context: {
        surroundingCode: node.getTemplate().getText().slice(0, 200),
        variableName: '',
        objectChain: [change.property ?? ''],
      },
    };
  }

  private listCodeFiles(dir: string): string[] {
    const results: string[] = [];
    const walk = (current: string): void => {
      let entries;
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
        let isDirectory;
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

  private deduplicate(callSites: CallSite[]): CallSite[] {
    const seen = new Set<string>();
    const unique: CallSite[] = [];
    for (const callSite of callSites) {
      const key = `${callSite.file}:${callSite.line}:${callSite.change.type}:${callSite.matchText}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(callSite);
      }
    }
    return unique;
  }
}

function tagBaseName(template: TaggedTemplateExpression): string {
  const tag = template.getTag().getText();
  const lastSegment = tag.split('.').pop() ?? tag;
  return lastSegment.replace(/^<.*>/, '');
}

function collectSelectedFields(document: DocumentNode): Set<string> {
  const fields = new Set<string>();
  for (const definition of document.definitions) {
    const selectionSet = (definition as { selectionSet?: SelectionSetNode }).selectionSet;
    if (selectionSet) {
      collectFromSelectionSet(selectionSet, fields);
    }
  }
  return fields;
}

function collectFromSelectionSet(selectionSet: SelectionSetNode, fields: Set<string>): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection;
      fields.add(field.name.value);
      if (field.selectionSet) {
        collectFromSelectionSet(field.selectionSet, fields);
      }
    }
  }
}

function enumValueSelected(sdl: string, valueName: string): boolean {
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(sdl);
}

function extension(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.slice(dot) : '';
}

function countNewlines(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char === '\n') {
      count++;
    }
  }
  return count;
}
