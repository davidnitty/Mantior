import type { BreakingChange } from '../diff/engine';
import type { ConfidenceScore } from '../fixer/confidence';
import { logger } from '../logger';
import { MantiorDatabase } from '../state/database';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export enum AutonomyLevel {
  /** Level 1: Monitoring only. */
  OBSERVE = 1,
  /** Level 2: Analysis + recommendations. */
  RECOMMEND = 2,
  /** Level 3: Sandbox testing (fixes in isolated clones, no PRs). */
  SIMULATE = 3,
  /** Level 4: PRs with human approval. */
  EXECUTE_WITH_APPROVAL = 4,
  /** Level 5: Automatic execution (low-risk only). */
  EXECUTE_AUTOMATIC = 5,
}

export interface AutonomyConfig {
  baseLevel: AutonomyLevel;
  overrides: Record<string, AutonomyLevel>;
  confidenceThresholds: Record<AutonomyLevel, number>;
  alwaysRequireApproval: string[];
  neverAutomate: string[];
}

export type ActionType = 'monitor' | 'recommend' | 'simulate' | 'pr_with_approval' | 'auto_execute';

export interface ActionPermissions {
  allowed: boolean;
  level: AutonomyLevel;
  action: ActionType | 'manual_required';
  requiresApproval: boolean;
  reason?: string;
  confidenceScore?: number;
  factors?: string[];
}

// ──────────────────────────────────────────────
// DEFAULT CONFIGURATION
// ──────────────────────────────────────────────

export const DEFAULT_CONFIG: AutonomyConfig = {
  baseLevel: AutonomyLevel.EXECUTE_WITH_APPROVAL,
  overrides: {
    property_renamed: AutonomyLevel.EXECUTE_AUTOMATIC,
    type_changed: AutonomyLevel.EXECUTE_WITH_APPROVAL,
    schema_removed: AutonomyLevel.EXECUTE_WITH_APPROVAL,
    endpoint_removed: AutonomyLevel.EXECUTE_WITH_APPROVAL,
    enum_value_removed: AutonomyLevel.EXECUTE_WITH_APPROVAL,
    required_added: AutonomyLevel.EXECUTE_AUTOMATIC,
  },
  confidenceThresholds: {
    [AutonomyLevel.OBSERVE]: 0,
    [AutonomyLevel.RECOMMEND]: 0,
    [AutonomyLevel.SIMULATE]: 30,
    [AutonomyLevel.EXECUTE_WITH_APPROVAL]: 70,
    [AutonomyLevel.EXECUTE_AUTOMATIC]: 90,
  },
  alwaysRequireApproval: ['schema_removed', 'endpoint_removed'],
  neverAutomate: ['database_migration', 'schema_drop'],
};

const SETTINGS_KEY = 'autonomy_level';

// ──────────────────────────────────────────────
// MAIN CLASS
// ──────────────────────────────────────────────

export class AutonomyManager {
  private readonly config: AutonomyConfig;
  private readonly db: MantiorDatabase;
  private userLevel: AutonomyLevel;

  constructor(userLevel?: AutonomyLevel, db = MantiorDatabase.getInstance()) {
    this.config = { ...DEFAULT_CONFIG };
    this.db = db;
    this.userLevel = userLevel ?? this.loadPersistedLevel();
  }

  getCurrentLevel(): AutonomyLevel {
    return this.userLevel;
  }

  setUserLevel(level: AutonomyLevel): void {
    this.userLevel = level;
    this.db.setSetting(SETTINGS_KEY, String(level));
    logger.info({ level: AutonomyLevel[level] }, 'Autonomy level updated');
  }

  getConfig(): AutonomyConfig {
    return this.config;
  }

  /**
   * Determine what action is allowed for a given change.
   */
  getActionPermissions(change: BreakingChange, confidence: ConfidenceScore): ActionPermissions {
    const effectiveLevel = this.getEffectiveLevel(change.type);

    if (this.config.neverAutomate.includes(change.type)) {
      return {
        allowed: false,
        level: AutonomyLevel.OBSERVE,
        action: 'manual_required',
        reason: 'This change type can never be automated',
        requiresApproval: true,
      };
    }

    const requiresApproval = this.config.alwaysRequireApproval.includes(change.type);

    const minConfidence = this.config.confidenceThresholds[effectiveLevel];
    if (confidence.score < minConfidence) {
      const downgradedLevel = this.downgradeForConfidence(confidence.score);
      return {
        allowed: true,
        level: downgradedLevel,
        action: this.getActionForLevel(downgradedLevel),
        reason: `Confidence (${confidence.score}%) below threshold for ${AutonomyLevel[effectiveLevel]} (${minConfidence}%)`,
        requiresApproval: true,
        confidenceScore: confidence.score,
      };
    }

    const action = this.getActionForLevel(effectiveLevel);
    return {
      allowed: true,
      level: effectiveLevel,
      action,
      requiresApproval: requiresApproval || action === 'pr_with_approval',
      confidenceScore: confidence.score,
      factors: confidence.factors,
    };
  }

  /**
   * Effective level = user preference, capped by the change-type override.
   * Overrides can downgrade (never upgrade) for safety.
   */
  private getEffectiveLevel(changeType: string): AutonomyLevel {
    let effectiveLevel = this.userLevel;
    const override = this.config.overrides[changeType];
    if (override !== undefined) {
      effectiveLevel = Math.min(effectiveLevel, override);
    }
    return effectiveLevel;
  }

  private downgradeForConfidence(confidence: number): AutonomyLevel {
    if (confidence >= 90) {
      return AutonomyLevel.EXECUTE_AUTOMATIC;
    }
    if (confidence >= 70) {
      return AutonomyLevel.EXECUTE_WITH_APPROVAL;
    }
    if (confidence >= 50) {
      return AutonomyLevel.SIMULATE;
    }
    if (confidence >= 30) {
      return AutonomyLevel.RECOMMEND;
    }
    return AutonomyLevel.OBSERVE;
  }

  private getActionForLevel(level: AutonomyLevel): ActionType {
    switch (level) {
      case AutonomyLevel.OBSERVE:
        return 'monitor';
      case AutonomyLevel.RECOMMEND:
        return 'recommend';
      case AutonomyLevel.SIMULATE:
        return 'simulate';
      case AutonomyLevel.EXECUTE_WITH_APPROVAL:
        return 'pr_with_approval';
      case AutonomyLevel.EXECUTE_AUTOMATIC:
        return 'auto_execute';
    }
  }

  getConfigDescription(): string {
    const levels = Object.values(AutonomyLevel).filter(
      (value): value is AutonomyLevel =>
        typeof value === 'number' && Number(value) >= 1 && Number(value) <= 5,
    );
    const descriptions: string[] = [];
    for (const level of levels) {
      const threshold = this.config.confidenceThresholds[level];
      descriptions.push(
        `  Level ${level} (${AutonomyLevel[level]}): ${this.getActionForLevel(level)} (confidence ≥ ${threshold}%)`,
      );
    }
    return `Autonomy Configuration:\n${descriptions.join('\n')}`;
  }

  private loadPersistedLevel(): AutonomyLevel {
    const stored = this.db.getSetting(SETTINGS_KEY);
    const parsed = stored === undefined ? undefined : Number.parseInt(stored, 10);
    if (parsed !== undefined && Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
      return parsed as AutonomyLevel;
    }
    return this.config.baseLevel;
  }
}
