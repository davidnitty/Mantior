import { readFileSync } from 'node:fs';

import { load as loadYaml } from 'js-yaml';

import { AuditLogger } from '../audit/logger';

export interface APISpec {
  id: string;
  name: string;
  version: string;
  content: Record<string, unknown>;
  path: string;
  lastUpdated: Date;
  consumers: string[];
}

export interface EndpointInfo {
  path: string;
  method: string;
  summary: string;
  parameters: unknown[];
  responses: Record<string, unknown>;
}

export interface DiffResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/** In-memory knowledge store for API specs (loaded from JSON or YAML files). */
export class SpecRepository {
  private readonly specs = new Map<string, APISpec>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
  }

  loadSpec(path: string): APISpec {
    const content = loadYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const info = asRecord(content.info);
    const title = typeof info.title === 'string' ? info.title : 'Unnamed API';
    const version = typeof info.version === 'string' ? info.version : '1.0.0';
    // Key by title:version so distinct versions of the same API don't collide.
    const id = `${title}:${version}`;
    const spec: APISpec = {
      id,
      name: title,
      version,
      content,
      path,
      lastUpdated: new Date(),
      consumers: [],
    };
    this.specs.set(spec.id, spec);
    this.audit.logAction({
      action: 'spec_loaded',
      metadata: { specId: spec.id, version: spec.version, path },
    });
    return spec;
  }

  getEndpoints(specId: string): EndpointInfo[] {
    const spec = this.specs.get(specId);
    if (!spec) {
      return [];
    }
    const endpoints: EndpointInfo[] = [];
    const paths = asRecord(spec.content.paths);
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, details] of Object.entries(asRecord(methods))) {
        const detail = asRecord(details);
        endpoints.push({
          path,
          method: method.toUpperCase(),
          summary: typeof detail.summary === 'string' ? detail.summary : '',
          parameters: Array.isArray(detail.parameters) ? detail.parameters : [],
          responses: asRecord(detail.responses),
        });
      }
    }
    return endpoints;
  }

  findSpec(name: string): APISpec | null {
    for (const spec of this.specs.values()) {
      if (spec.name === name) {
        return spec;
      }
    }
    return null;
  }

  compareSpecs(oldSpecId: string, newSpecId: string): DiffResult {
    const oldSpec = this.specs.get(oldSpecId);
    const newSpec = this.specs.get(newSpecId);
    if (!oldSpec || !newSpec) {
      throw new Error('Spec not found');
    }
    const changes: DiffResult = { added: [], removed: [], changed: [] };
    const oldPaths = new Set(this.getEndpoints(oldSpecId).map(e => `${e.method}:${e.path}`));
    const newPaths = new Set(this.getEndpoints(newSpecId).map(e => `${e.method}:${e.path}`));
    for (const path of oldPaths) {
      if (!newPaths.has(path)) {
        changes.removed.push(path);
      }
    }
    for (const path of newPaths) {
      if (!oldPaths.has(path)) {
        changes.added.push(path);
      }
    }
    return changes;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
