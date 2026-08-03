import crypto from 'node:crypto';

import { verifyGitHubSignature } from '../handler';

function sign(payload: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

describe('verifyGitHubSignature', () => {
  const secret = 'test-secret';
  const payload = '{"event":"push","repository":{"full_name":"acme/web"}}';

  it('accepts a valid signature', () => {
    expect(verifyGitHubSignature(payload, sign(payload, secret), secret)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyGitHubSignature(payload, sign(payload, 'other-secret'), secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGitHubSignature(payload, undefined, secret)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifyGitHubSignature(payload, 'md5=deadbeef', secret)).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    expect(verifyGitHubSignature(payload, 'sha256=abc', secret)).toBe(false);
  });
});

describe('verifyGitHubSignature without a configured secret', () => {
  const original = process.env.NODE_ENV;

  afterAll(() => {
    if (original === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = original;
    }
  });

  it('allows unverified requests outside production (dev)', () => {
    process.env.NODE_ENV = 'test';
    expect(verifyGitHubSignature('{}', undefined, '')).toBe(true);
  });

  it('fails CLOSED in production', () => {
    process.env.NODE_ENV = 'production';
    expect(verifyGitHubSignature('{}', undefined, '')).toBe(false);
  });
});
