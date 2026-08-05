import { logger } from './logger';
import { Notifier } from './notifier';
import { MantiorDatabase } from './state/database';

export interface CostConfig {
  /** Maximum LLM cost per scan run in USD. */
  maxCostPerScan: number;
  /** Maximum LLM cost per day in USD (HARD STOP). */
  maxCostPerDay: number;
  /** Maximum LLM cost per month in USD. */
  maxCostPerMonth: number;
  /** Alert when today's spend reaches this fraction of the daily limit. */
  alertThreshold: number;
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  maxCostPerScan: 10,
  maxCostPerDay: 100,
  maxCostPerMonth: 500,
  alertThreshold: 0.8,
};

/** Build cost caps from env with sane defaults (MANTIOR_MAX_COST_*). */
export function costConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CostConfig {
  return {
    maxCostPerScan: envNumber(env.MANTIOR_MAX_COST_PER_SCAN, DEFAULT_COST_CONFIG.maxCostPerScan),
    maxCostPerDay: envNumber(env.MANTIOR_MAX_COST_PER_DAY, DEFAULT_COST_CONFIG.maxCostPerDay),
    maxCostPerMonth: envNumber(env.MANTIOR_MAX_COST_PER_MONTH, DEFAULT_COST_CONFIG.maxCostPerMonth),
    alertThreshold: envNumber(env.MANTIOR_COST_ALERT_THRESHOLD, DEFAULT_COST_CONFIG.alertThreshold),
  };
}

export interface CostDecision {
  allowed: boolean;
  reason?: string;
}

export interface LLMTokens {
  input: number;
  output: number;
}

/**
 * Guards LLM spend with per-scan / per-day / per-month caps. Costs are
 * persisted to the SQLite metrics table (name = `llm_cost`) so limits survive
 * restarts, and a HARD STOP blocks further calls once a cap is hit.
 */
export class CostController {
  private readonly config: CostConfig;
  private readonly db: MantiorDatabase;
  private readonly notifier: Notifier;
  private scanCost = 0;

  constructor(
    config: Partial<CostConfig> = {},
    db = MantiorDatabase.getInstance(),
    notifier = new Notifier(),
  ) {
    this.config = { ...DEFAULT_COST_CONFIG, ...config };
    this.db = db;
    this.notifier = notifier;
  }

  /** Reset the per-scan accumulator at the start of a scan run. */
  beginScan(): void {
    this.scanCost = 0;
  }

  canProceed(): CostDecision {
    if (this.scanCost >= this.config.maxCostPerScan) {
      return {
        allowed: false,
        reason: `Scan cost limit exceeded: $${this.scanCost.toFixed(2)} / $${this.config.maxCostPerScan.toFixed(2)}`,
      };
    }
    const todayCost = this.getTodayCost();
    if (todayCost >= this.config.maxCostPerDay) {
      return {
        allowed: false,
        reason: `Daily cost limit exceeded: $${todayCost.toFixed(2)} / $${this.config.maxCostPerDay.toFixed(2)}`,
      };
    }
    const monthCost = this.getMonthCost();
    if (monthCost >= this.config.maxCostPerMonth) {
      return {
        allowed: false,
        reason: `Monthly cost limit exceeded: $${monthCost.toFixed(2)} / $${this.config.maxCostPerMonth.toFixed(2)}`,
      };
    }
    return { allowed: true };
  }

  /** Remaining daily budget — used by the LLM router for downgrades. */
  getRemainingBudget(): number {
    return Math.max(0, this.config.maxCostPerDay - this.getTodayCost());
  }

  trackLLMCall(model: string, tokens: LLMTokens, cost: number): void {
    this.scanCost += cost;
    this.db.insertMetric({
      timestamp: new Date().toISOString(),
      name: 'llm_cost',
      value: cost,
      labels: JSON.stringify({ model, inputTokens: tokens.input, outputTokens: tokens.output }),
    });
    logger.debug({ model, tokens, cost }, 'LLM cost tracked');
    void this.checkThresholds();
  }

  getTodayCost(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.sumMetricByName('llm_cost', `${today}T00:00:00.000Z`);
  }

  getMonthCost(): number {
    const month = new Date().toISOString().slice(0, 7);
    return this.db.sumMetricByName('llm_cost', `${month}-01T00:00:00.000Z`);
  }

  private async checkThresholds(): Promise<void> {
    const todayCost = this.getTodayCost();
    const dailyLimit = this.config.maxCostPerDay;
    const ratio = dailyLimit > 0 ? todayCost / dailyLimit : 0;
    if (ratio >= this.config.alertThreshold) {
      const percent = Math.round(ratio * 100);
      logger.warn(
        { todayCost, dailyLimit, threshold: this.config.alertThreshold },
        'Cost threshold approaching',
      );
      await this.notifier.notify({
        text: `⚠️ Mantior LLM cost at ${percent}% of the daily limit ($${todayCost.toFixed(2)} / $${dailyLimit.toFixed(2)}).`,
        fields: { todayCost: `$${todayCost.toFixed(2)}`, dailyLimit: `$${dailyLimit.toFixed(2)}` },
      });
    }
  }
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
