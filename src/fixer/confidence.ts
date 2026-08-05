import type { BreakingChange } from '../diff/engine';

export interface ConfidenceScore {
  /** 0-100 — how certain Mantior is that the proposed fix is correct. */
  score: number;
  /** Human-readable reasons behind the score (audit trail). */
  factors: string[];
}

/**
 * Deterministic confidence scoring for breaking changes. Starts from the diff
 * engine's heuristic confidence and adjusts for mechanical detectability:
 * affix-only renames (amount → amount_cents) are near-certain; semantic
 * renames inherit the engine's heuristic confidence.
 */
export class ConfidenceCalculator {
  calculate(change: BreakingChange, _context: Record<string, unknown>): ConfidenceScore {
    const factors: string[] = [`diff heuristic: ${change.confidence}`];
    let score = clamp(change.confidence, 0, 100);

    if (change.type === 'property_renamed' && change.property && change.newProperty) {
      const oldName = change.property.replace(/_/g, '').toLowerCase();
      const newName = change.newProperty.replace(/_/g, '').toLowerCase();
      if (oldName === newName) {
        score = Math.max(score, 92);
        factors.push('mechanical rename (punctuation-only)');
      } else if (newName.startsWith(oldName) || oldName.startsWith(newName)) {
        score = Math.max(score, 85);
        factors.push('affix rename');
      } else {
        factors.push('semantic rename');
      }
    }

    if (change.severity === 'safe') {
      score = Math.min(score, 40);
      factors.push('unverified severity');
    }

    return { score: clamp(score, 0, 100), factors };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
