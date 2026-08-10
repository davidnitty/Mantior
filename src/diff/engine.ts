import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import axios from 'axios';
import { load as loadYaml } from 'js-yaml';
import { difference, intersection, union } from 'lodash';

import { logger } from '../logger';

// ──────────────────────────────────────────────
// BREAKING CHANGE CONTRACT
// ──────────────────────────────────────────────

export type BreakingChangeType =
  | 'endpoint_removed'
  | 'endpoint_renamed'
  | 'schema_removed'
  | 'schema_renamed'
  | 'property_removed'
  | 'property_renamed'
  | 'type_changed'
  | 'required_added'
  | 'enum_value_removed'
  // GraphQL protocol
  | 'type_removed'
  | 'field_removed'
  | 'field_type_changed'
  | 'field_deprecated';

export type ChangeSeverity = 'breaking' | 'risky' | 'safe';

export interface BreakingChange {
  type: BreakingChangeType;
  severity: ChangeSeverity;
  oldValue?: string;
  newValue?: string;
  path?: string;
  schema?: string;
  property?: string;
  newProperty?: string;
  oldType?: string;
  newType?: string;
  message: string;
  confidence: number;
}

export type SpecInput = string | Record<string, unknown>;

// ──────────────────────────────────────────────
// DIFF ENGINE
// ──────────────────────────────────────────────

/**
 * OpenAPI v1 (live) → v2 (local spec) comparison.
 * Both inputs may be a spec object, an http(s) URL, or a local .yaml/.json path.
 */
export class DiffEngine {
  async compare(oldInput: SpecInput, newInput: SpecInput): Promise<BreakingChange[]> {
    logger.debug(
      { oldInput: describeInput(oldInput), newInput: describeInput(newInput) },
      'Comparing API specs',
    );

    const oldSpec = await this.loadSpec(oldInput);
    const newSpec = await this.loadSpec(newInput);
    const changes: BreakingChange[] = [];

    // 1. ENDPOINT CHANGES
    const oldPaths = Object.keys(asRecord(oldSpec.paths));
    const newPaths = Object.keys(asRecord(newSpec.paths));

    const removedPaths = difference(oldPaths, newPaths);
    for (const path of removedPaths) {
      changes.push({
        type: 'endpoint_removed',
        severity: 'breaking',
        path,
        oldValue: path,
        message: `Endpoint "${path}" was removed.`,
        confidence: 100,
      });
    }

    const addedPaths = difference(newPaths, oldPaths);
    for (const path of addedPaths) {
      const renamedFrom = this.findRenamedEndpoint(oldSpec, newSpec, path);
      if (renamedFrom) {
        changes.push({
          type: 'endpoint_renamed',
          severity: 'breaking',
          path: renamedFrom,
          oldValue: renamedFrom,
          newValue: path,
          message: `Endpoint "${renamedFrom}" renamed to "${path}".`,
          confidence: 70,
        });
      }
    }

    // 2. SCHEMA CHANGES
    const oldSchemas = asRecord(asRecord(oldSpec.components).schemas);
    const newSchemas = asRecord(asRecord(newSpec.components).schemas);
    const allSchemas = union(Object.keys(oldSchemas), Object.keys(newSchemas));

    for (const schemaName of allSchemas) {
      const oldSchema = asRecord(oldSchemas[schemaName]);
      const newSchema = asRecord(newSchemas[schemaName]);

      // 2a. Schema removed
      if (newSchemas[schemaName] === undefined) {
        changes.push({
          type: 'schema_removed',
          severity: 'breaking',
          schema: schemaName,
          oldValue: schemaName,
          message: `Schema "${schemaName}" was removed.`,
          confidence: 100,
        });
        continue;
      }

      // 2b. New schema: possibly a renamed version of an old schema
      if (oldSchemas[schemaName] === undefined) {
        const renamedFrom = this.findRenamedSchema(oldSchemas, newSchema, schemaName);
        if (renamedFrom) {
          changes.push({
            type: 'schema_renamed',
            severity: 'breaking',
            schema: renamedFrom,
            oldValue: renamedFrom,
            newValue: schemaName,
            message: `Schema "${renamedFrom}" renamed to "${schemaName}".`,
            confidence: 80,
          });
        }
        continue;
      }

      // 3. PROPERTY CHANGES (within shared schemas)
      this.collectPropertyChanges(changes, schemaName, oldSchema, newSchema);
    }

    logger.info({ changeCount: changes.length }, 'Diff complete');
    return changes;
  }

  // ──────────────────────────────────────────────
  // PROPERTY-LEVEL DIFFS
  // ──────────────────────────────────────────────

  private collectPropertyChanges(
    changes: BreakingChange[],
    schemaName: string,
    oldSchema: Record<string, unknown>,
    newSchema: Record<string, unknown>,
  ): void {
    const oldProps = Object.keys(asRecord(oldSchema.properties));
    const newProps = Object.keys(asRecord(newSchema.properties));

    // 3a. Removed properties
    const removed = difference(oldProps, newProps);
    for (const prop of removed) {
      changes.push({
        type: 'property_removed',
        severity: 'breaking',
        schema: schemaName,
        property: prop,
        oldValue: prop,
        message: `Property "${prop}" removed from schema "${schemaName}".`,
        confidence: 100,
      });
    }

    // 3b. Renames: exactly one removed + one added with similar names
    const added = difference(newProps, oldProps);
    if (removed.length === 1 && added.length === 1) {
      const oldProp = removed[0] ?? '';
      const newProp = added[0] ?? '';
      const similarity = this.calculateSimilarity(oldProp, newProp);
      // Affix renames (amount → amount_cents) are common and deterministic.
      const containsRename = oldProp.includes(newProp) || newProp.includes(oldProp);
      if (similarity > 0.6 || containsRename) {
        changes.push({
          type: 'property_renamed',
          severity: 'breaking',
          schema: schemaName,
          property: oldProp,
          newProperty: newProp,
          oldValue: oldProp,
          newValue: newProp,
          message: `Property "${oldProp}" renamed to "${newProp}" in schema "${schemaName}".`,
          confidence: Math.round(similarity * 100),
        });
      }
    }

    const sharedProps = intersection(oldProps, newProps);
    const oldRequired = asStringList(asRecord(oldSchema).required);
    const newRequired = asStringList(asRecord(newSchema).required);

    for (const prop of sharedProps) {
      const oldProperty = asRecord(oldSchema.properties)[prop];
      const newProperty = asRecord(newSchema.properties)[prop];

      // 3c. Type changes
      const oldType = this.getPropertyType(oldProperty);
      const newType = this.getPropertyType(newProperty);
      if (oldType !== null && newType !== null && oldType !== newType) {
        changes.push({
          type: 'type_changed',
          severity: 'breaking',
          schema: schemaName,
          property: prop,
          oldValue: oldType,
          newValue: newType,
          oldType,
          newType,
          message: `Property "${prop}" type changed from "${oldType}" to "${newType}" in schema "${schemaName}".`,
          confidence: 100,
        });
      }

      // 3e. Enum values removed
      const oldEnum = asStringList(asRecord(oldProperty).enum);
      const newEnum = asStringList(asRecord(newProperty).enum);
      for (const value of difference(oldEnum, newEnum)) {
        changes.push({
          type: 'enum_value_removed',
          severity: 'breaking',
          schema: schemaName,
          property: prop,
          oldValue: value,
          message: `Enum value "${value}" removed from property "${prop}" in schema "${schemaName}".`,
          confidence: 100,
        });
      }
    }

    // 3d. Required fields added
    for (const prop of difference(newRequired, oldRequired)) {
      changes.push({
        type: 'required_added',
        severity: 'risky',
        schema: schemaName,
        property: prop,
        newValue: prop,
        message: `Property "${prop}" is now required in schema "${schemaName}".`,
        confidence: 100,
      });
    }
  }

  // ──────────────────────────────────────────────
  // RENAME HEURISTICS
  // ──────────────────────────────────────────────

  private findRenamedEndpoint(
    oldSpec: Record<string, unknown>,
    newSpec: Record<string, unknown>,
    newPath: string,
  ): string | undefined {
    const newMethod = this.endpointMethod(newSpec, newPath);
    const oldPaths = Object.keys(asRecord(oldSpec.paths));
    for (const oldPath of oldPaths) {
      const oldMethod = this.endpointMethod(oldSpec, oldPath);
      if (oldMethod !== null && oldMethod === newMethod && this.arePathsSimilar(oldPath, newPath)) {
        return oldPath;
      }
    }
    return undefined;
  }

  private endpointMethod(spec: Record<string, unknown>, path: string): string | null {
    const operations = asRecord(asRecord(spec.paths)[path]);
    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      if (operations[method] !== undefined) {
        return method.toUpperCase();
      }
    }
    return null;
  }

  private findRenamedSchema(
    oldSchemas: Record<string, unknown>,
    newSchema: Record<string, unknown>,
    newSchemaName: string,
  ): string | undefined {
    const newProps = Object.keys(asRecord(newSchema.properties));
    for (const [oldName, oldSchema] of Object.entries(oldSchemas)) {
      if (oldSchemas[newSchemaName] !== undefined) {
        continue;
      }
      const oldProps = Object.keys(asRecord(asRecord(oldSchema).properties));
      const overlap = intersection(oldProps, newProps);
      if (oldProps.length > 0 && overlap.length > oldProps.length * 0.7) {
        return oldName;
      }
    }
    return undefined;
  }

  // ──────────────────────────────────────────────
  // SPEC LOADING
  // ──────────────────────────────────────────────

  private async loadSpec(input: SpecInput): Promise<Record<string, unknown>> {
    if (typeof input !== 'string') {
      return input;
    }
    let document: string;
    if (/^https?:\/\//.test(input)) {
      const response = await axios.get<string | Record<string, unknown>>(input, {
        timeout: 30_000,
      });
      const data: unknown = response.data;
      document = typeof data === 'string' ? data : JSON.stringify(data);
    } else {
      document = readFileSync(resolve(process.cwd(), input), 'utf8');
    }
    const parsed = loadYaml(document, { json: true });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Spec at "${input}" must be an OpenAPI document (mapping)`);
    }
    return parsed as Record<string, unknown>;
  }

  // ──────────────────────────────────────────────
  // TYPE / SIMILARITY HELPERS
  // ──────────────────────────────────────────────

  private getPropertyType(property: unknown): string | null {
    if (property === undefined || property === null) {
      return null;
    }
    const record = asRecord(property);
    if (typeof record.type === 'string') {
      return record.type;
    }
    if (record.$ref !== undefined) {
      return 'object';
    }
    if (record.allOf !== undefined) {
      return 'object';
    }
    return null;
  }

  private arePathsSimilar(path1: string, path2: string): boolean {
    const clean1 = path1.replace(/\/v\d+\//g, '/');
    const clean2 = path2.replace(/\/v\d+\//g, '/');
    return clean1 === clean2 || clean1.includes(clean2) || clean2.includes(clean1);
  }

  private calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    if (longer.length === 0) {
      return 1;
    }
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) => {
      const row = new Array<number>(a.length + 1).fill(0);
      row[0] = i;
      return row;
    });
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
}

// ──────────────────────────────────────────────
// GENERIC NAVIGATION HELPERS
// ──────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function describeInput(input: SpecInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return '(object)';
}
