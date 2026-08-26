import { describe, expect, it } from '@jest/globals';

import { SecretMasker } from '../secret-masker';

describe('SecretMasker', () => {
  it('masks Stripe keys and round-trips them back', () => {
    const masker = new SecretMasker();
    const source = 'const key = "sk_live_1234567890abcdefghijklmnop";';

    const masked = masker.mask(source);
    expect(masked).not.toContain('sk_live_');
    expect(masked).toContain('__MANTIOR_SEC_1__');

    const restored = masker.unmask('const key = "__MANTIOR_SEC_1__";');
    expect(restored).toContain('sk_live_1234567890abcdefghijklmnop');
  });

  it('masks GitHub PATs, Slack tokens and AWS access key IDs', () => {
    const masker = new SecretMasker();
    const source = [
      'const pat = "ghp_' + 'a'.repeat(36) + '";',
      'const slack = "xoxb-1234567890-abcdefghij";',
      'const awsId = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');

    const masked = masker.mask(source);
    expect(masked).not.toContain('ghp_');
    expect(masked).not.toContain('xoxb-');
    expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(masker.maskedCount).toBe(3);
  });

  it('masks hardcoded env-var assignments', () => {
    const masker = new SecretMasker();
    const masked = masker.mask('password = "hunter2secret";');

    expect(masked).not.toContain('hunter2secret');
    expect(masked).toContain('__MANTIOR_SEC_');
  });

  it('masks PEM private keys (multi-line)', () => {
    const masker = new SecretMasker();
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

    const masked = masker.mask(pem);
    expect(masked).not.toContain('BEGIN PRIVATE KEY');
    expect(masked).toContain('__MANTIOR_SEC_');
    expect(masker.unmask(masked)).toBe(pem);
  });

  it('reuses the same placeholder for a repeated value', () => {
    const masker = new SecretMasker();
    const source =
      'const a = "ghp_' + 'b'.repeat(36) + '";\nconst b = "ghp_' + 'b'.repeat(36) + '";';

    const masked = masker.mask(source);
    expect(masker.maskedCount).toBe(1);
    expect(masked).toContain('__MANTIOR_SEC_1__');
    expect(masked).not.toContain('__MANTIOR_SEC_2__');
  });

  it('leaves non-secret text untouched', () => {
    const masker = new SecretMasker();
    const source = 'const url = "https://api.example.com/v1/charges?currency=usd";';
    expect(masker.mask(source)).toBe(source);
    expect(masker.maskedCount).toBe(0);
  });

  it('reports only placeholders in its audit log (never values)', () => {
    const masker = new SecretMasker();
    masker.mask('const token = "sk_live_1234567890abcdefghijklmnop";');

    const audit = masker.getAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('__MANTIOR_SEC_1__');
    expect(audit[0]).not.toContain('sk_live_');
  });
});
