import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { AuditLogger } from '../../audit/logger';
import { MantiorDatabase } from '../../state/database';
import { InputValidator } from '../validation';

describe('InputValidator', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-validate-'));
    dbPath = join(testDir, 'test.db');
  });

  afterEach(() => {
    MantiorDatabase.getInstance(dbPath).close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const validator = (): InputValidator =>
    new InputValidator(new AuditLogger(MantiorDatabase.getInstance(dbPath)));

  it('reports unknown schemas', () => {
    const result = validator().validate('no-such-schema', {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Schema not found');
  });

  it('validates a well-formed api-config', () => {
    const result = validator().validate('api-config', {
      name: 'Payments',
      spec: 'openapi.yaml',
      reference_url: 'https://api.example.com/openapi.yaml',
      consumers: [{ repo: 'acme/web', branch: 'main', language: 'typescript' }],
    });
    expect(result.valid).toBe(true);
    expect(result.sanitized).toBeDefined();
  });

  it('rejects a malformed api-config', () => {
    const result = validator().validate('api-config', {
      name: '',
      spec: '',
      reference_url: 'not-a-url',
      consumers: [{ repo: 'bad', branch: '', language: 'golang' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('sanitizes dangerous characters', () => {
    expect(validator().sanitize('a<b&c\'d"e')).toBe('abcde');
    expect(validator().sanitize('  spaced  ')).toBe('spaced');
  });

  it('blocks path traversal', () => {
    const v = validator();
    expect(v.validatePath('src/file.ts')).toBe(true);
    expect(v.validatePath('../secret')).toBe(false);
    expect(v.validatePath('a/./b')).toBe(false);
    expect(v.validatePath('a//b')).toBe(false);
  });

  it('blocks SSRF targets in URLs', () => {
    const v = validator();
    expect(v.validateURL('https://api.stripe.com/v1')).toBe(true);
    expect(v.validateURL('ftp://example.com')).toBe(false);
    expect(v.validateURL('http://localhost:8080')).toBe(false);
    expect(v.validateURL('http://127.0.0.1/x')).toBe(false);
    expect(v.validateURL('http://192.168.1.1/x')).toBe(false);
    expect(v.validateURL('http://10.0.0.1/x')).toBe(false);
    expect(v.validateURL('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(v.validateURL('not a url')).toBe(false);
  });

  it('validates repository names', () => {
    const v = validator();
    expect(v.validateRepoName('acme/web')).toBe(true);
    expect(v.validateRepoName('acme')).toBe(false);
    expect(v.validateRepoName('acme/web repo')).toBe(false);
  });

  it('supports custom schemas', () => {
    const v = validator();
    v.addSchema('custom', z.object({ id: z.number() }));
    expect(v.validate('custom', { id: 1 }).valid).toBe(true);
    expect(v.validate('custom', { id: 'x' }).valid).toBe(false);
  });
});
