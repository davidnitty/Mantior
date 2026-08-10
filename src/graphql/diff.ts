import { existsSync, readFileSync } from 'node:fs';

import axios from 'axios';

import { type BreakingChange } from '../diff/engine';

import { type GraphQLSchemaModel, GraphQLSchemaParser } from './schema';

/**
 * Input for GraphQL comparison: a path to a `.graphql`/`.gql` file, an
 * http(s) URL serving the SDL, or inline SDL text.
 */
export type SDLInput = string;

const bespoke = (change: BreakingChange): BreakingChange => change;

/**
 * GraphQL SDL v1 → v2 comparison. Detects the breaking contract changes that
 * break consumer clients:
 *   - type removal
 *   - field removal / rename (object + input types)
 *   - field type changes (incl. non-null tightening) and enum value removal
 *   - new field deprecations
 * Emits the same `BreakingChange` contract as the OpenAPI engine so the rest
 * of the fix pipeline is protocol-agnostic.
 */
export class GraphQLDiffEngine {
  private readonly parser = new GraphQLSchemaParser();

  compare(oldInput: SDLInput, newInput: SDLInput): Promise<BreakingChange[]> {
    return Promise.all([this.loadSDL(oldInput), this.loadSDL(newInput)]).then(([oldSdl, newSdl]) =>
      this.diffModels(this.parser.parse(oldSdl), this.parser.parse(newSdl)),
    );
  }

  diffModels(oldModel: GraphQLSchemaModel, newModel: GraphQLSchemaModel): BreakingChange[] {
    const changes: BreakingChange[] = [];
    const oldTypes = oldModel.types;
    const newTypes = newModel.types;
    const allNames = new Set([...oldTypes.keys(), ...newTypes.keys()]);

    for (const name of allNames) {
      const oldType = oldTypes.get(name);
      const newType = newTypes.get(name);

      // Type removed.
      if (oldType && !newType) {
        changes.push(
          bespoke({
            type: 'type_removed',
            severity: 'breaking',
            schema: name,
            oldValue: name,
            message: `GraphQL type "${name}" was removed.`,
            confidence: 100,
          }),
        );
        continue;
      }
      if (!oldType) {
        continue; // New type added — additive, non-breaking.
      }
      if (!newType) {
        continue;
      }

      // Enum values removed.
      if (oldType.kind === 'ENUM' && newType.kind === 'ENUM') {
        this.diffEnum(changes, name, oldType.values ?? [], newType.values ?? []);
        continue;
      }

      // Field-level diffs for object / interface / input types that still define fields.
      if (oldType.fields && newType.fields) {
        this.diffFields(changes, name, oldType.fields, newType.fields);
      }
    }

    return changes;
  }

  private diffEnum(
    changes: BreakingChange[],
    typeName: string,
    oldValues: string[],
    newValues: string[],
  ): void {
    const newValueSet = new Set(newValues);
    for (const value of oldValues) {
      if (!newValueSet.has(value)) {
        changes.push(
          bespoke({
            type: 'enum_value_removed',
            severity: 'breaking',
            schema: typeName,
            property: value,
            oldValue: value,
            message: `GraphQL enum "${typeName}" value "${value}" was removed.`,
            confidence: 100,
          }),
        );
      }
    }
  }

  private diffFields(
    changes: BreakingChange[],
    typeName: string,
    oldFields: Map<string, { name: string; type: string; deprecationReason?: string }>,
    newFields: Map<string, { name: string; type: string; deprecationReason?: string }>,
  ): void {
    const oldNames = [...oldFields.keys()];
    const newNames = [...newFields.keys()];
    const removedNames = oldNames.filter(name => !newFields.has(name));
    let addedNames = newNames.filter(name => !oldFields.has(name));

    // Detect renames first so removed/added pairs collapse into one change.
    const renamePairs: Array<[string, string]> = [];
    for (const removed of removedNames) {
      const match = addedNames.find(added => isLikelyRename(removed, added));
      if (match) {
        renamePairs.push([removed, match]);
        addedNames = addedNames.filter(name => name !== match);
      } else {
        changes.push(
          bespoke({
            type: 'field_removed',
            severity: 'breaking',
            schema: typeName,
            property: removed,
            message: `GraphQL field "${typeName}.${removed}" was removed.`,
            confidence: 100,
          }),
        );
      }
    }

    for (const pair of renamePairs) {
      const [removed, added] = pair;
      changes.push(
        bespoke({
          type: 'property_renamed',
          severity: 'breaking',
          schema: typeName,
          property: removed,
          newProperty: added,
          message: `GraphQL field "${typeName}.${removed}" renamed to "${added}".`,
          confidence: 78,
        }),
      );
    }

    // Remaining `addedNames` are additive fields: non-breaking, no change emitted.

    // Common fields: type changes and new deprecations.
    for (const name of oldNames) {
      const oldField = oldFields.get(name);
      const newField = newFields.get(name);
      if (!oldField || !newField) {
        continue;
      }
      if (oldField.type !== newField.type) {
        changes.push(
          bespoke({
            type: 'field_type_changed',
            severity: 'breaking',
            schema: typeName,
            property: name,
            oldType: oldField.type,
            newType: newField.type,
            message: `GraphQL field "${typeName}.${name}" type changed from "${oldField.type}" to "${newField.type}".`,
            confidence: 95,
          }),
        );
      }
      if (!oldField.deprecationReason && newField.deprecationReason) {
        changes.push(
          bespoke({
            type: 'field_deprecated',
            severity: 'risky',
            schema: typeName,
            property: name,
            message: `GraphQL field "${typeName}.${name}" was deprecated: ${newField.deprecationReason}`,
            confidence: 100,
          }),
        );
      }
    }
  }

  private loadSDL(input: SDLInput): Promise<string> {
    if (/^https?:\/\//i.test(input)) {
      return axios
        .get<string>(input, { transformResponse: [data => data as string] })
        .then(response => response.data);
    }
    if (existsSync(input)) {
      return Promise.resolve(readFileSync(input, 'utf8'));
    }
    return Promise.resolve(input);
  }
}

/** Normalized equality — `user_id` == `userId` — plus a Levenshtein ratio guard. */
function isLikelyRename(oldName: string, newName: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/_/g, '');
  if (normalize(oldName) === normalize(newName)) {
    return true;
  }
  return levenshteinRatio(oldName, newName) >= 0.8;
}

function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length, 1);
  if (max === 1) {
    return a === b ? 1 : 0;
  }
  const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, j) => [j]);
  for (let i = 0; i <= a.length; i++) {
    matrix[0][i] = i;
  }
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost,
      );
    }
  }
  return 1 - matrix[b.length][a.length] / max;
}
