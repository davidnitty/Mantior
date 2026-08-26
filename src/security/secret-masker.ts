import { logger } from '../logger';

export interface MaskedSecret {
  placeholder: string;
  originalValue: string;
}

/**
 * Detects and masks secrets before code is sent to an LLM, preventing the
 * accidental leakage of production credentials. Values are replaced with
 * deterministic placeholders (`__MANTIOR_SEC_N__`) before the prompt is
 * built, and swapped back in after the model returns its code.
 */
export class SecretMasker {
  private readonly secrets: MaskedSecret[] = [];
  private readonly placeholderPrefix = '__MANTIOR_SEC_';

  // Common high-risk secret patterns.
  private readonly patterns: Array<{ name: string; regex: RegExp }> = [
    { name: 'Stripe Secret Key', regex: /sk_live_[0-9a-zA-Z]{24,}/g },
    { name: 'Stripe Publishable Key', regex: /pk_live_[0-9a-zA-Z]{24,}/g },
    { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/g },
    // Broad: a 40-char base64-ish run (AWS secret key). Use with caution.
    {
      name: 'AWS Secret Access Key',
      regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    },
    { name: 'GitHub PAT', regex: /ghp_[a-zA-Z0-9]{36}/g },
    { name: 'Slack Token', regex: /xox[baprs]-[0-9a-zA-Z-]{10,}/g },
    {
      name: 'Generic Env Var (Hardcoded)',
      regex: /(?:password|secret|token|api_key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
    },
    // PEM private keys (may span multiple lines).
    {
      name: 'Private Key',
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    },
  ];

  /**
   * Scan source code, replace secrets with deterministic placeholders, and
   * store the mapping for later unmasking. Identical values reuse the same
   * placeholder so round-tripping stays consistent.
   */
  mask(sourceCode: string): string {
    let maskedCode = sourceCode;

    for (const { regex } of this.patterns) {
      maskedCode = maskedCode.replace(regex, match => {
        // Never re-mask a value that already contains a placeholder — this
        // keeps a later broad pattern from consuming a prior mask and breaking
        // the round-trip.
        if (match.includes(this.placeholderPrefix)) {
          return match;
        }
        const existing = this.secrets.find(secret => secret.originalValue === match);
        if (existing) {
          return existing.placeholder;
        }

        const id = this.secrets.length + 1;
        const placeholder = `${this.placeholderPrefix}${id}__`;

        this.secrets.push({ placeholder, originalValue: match });
        return placeholder;
      });
    }

    return maskedCode;
  }

  /**
   * Restore the original secrets into LLM-generated code.
   */
  unmask(llmGeneratedCode: string): string {
    let restoredCode = llmGeneratedCode;

    for (const { placeholder, originalValue } of this.secrets) {
      // split/join instead of replace to handle regex-special chars in secrets.
      restoredCode = restoredCode.split(placeholder).join(originalValue);
    }

    return restoredCode;
  }

  /**
   * Returns a list of secret types found (for audit logging).
   * NEVER log the actual values — only the placeholders.
   */
  getAuditLog(): string[] {
    return this.secrets.map(
      (_secret, index) =>
        `Detected secret #${index + 1} (masked as ${this.placeholderPrefix}${index + 1}__)`,
    );
  }

  /**
   * Log the detection summary (placeholders only) to the structured logger.
   */
  logDetections(): void {
    const audit = this.getAuditLog();
    if (audit.length > 0) {
      logger.warn({ detected: audit.length, audit }, 'Secrets masked before LLM prompt');
    }
  }

  /** Number of distinct secret values currently held in memory. */
  get maskedCount(): number {
    return this.secrets.length;
  }
}
