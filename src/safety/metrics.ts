import client from 'prom-client';

import { logger } from '../logger';
import { register as mantiorRegister } from '../monitoring/metrics';

export interface ProductMetrics {
  // Incident Metrics
  incidentsDetected: number;
  meanTimeToDetect: number; // minutes
  meanTimeToResolve: number; // minutes

  // Remediation Metrics
  correctDiagnosisRate: number; // percentage
  successfulRemediationRate: number; // percentage
  rollbackRate: number; // percentage
  falsePositiveRate: number; // percentage

  // Operational Metrics
  humanApprovalRate: number; // percentage
  costPerIncident: number; // USD
  tokensPerTask: number;
  toolCallsPerTask: number;

  // Business Metrics
  customerRetention: number; // percentage
  revenuePerAccount: number; // USD
}

export interface AgentMetrics {
  // Performance
  averageResponseTime: number; // milliseconds
  throughput: number; // tasks per hour
  successRate: number; // percentage

  // Quality
  confidenceScore: number; // average confidence
  hallucinationRate: number; // percentage
  contextAccuracy: number; // percentage

  // Efficiency
  costPerTask: number; // USD
  tokensPerResponse: number;
  toolUseCount: number;
}

interface IncidentRecord {
  occurredAt: number;
  detectedAt: number;
  falsePositive?: boolean;
  cost?: number;
}

interface RemediationRecord {
  startedAt: number;
  resolvedAt: number;
  successful?: boolean;
  diagnosisCorrect?: boolean;
  rolledBack?: boolean;
  approved?: boolean;
  tokensUsed?: number;
  toolCalls?: number;
}

interface TaskRecord {
  duration?: number;
  confidence?: number;
  hallucination?: boolean;
  contextAccurate?: boolean;
  cost?: number;
  tokensPerResponse?: number;
  toolCalls?: number;
}

interface BusinessData {
  retention: number;
  revenuePerAccount: number;
}

/**
 * Outcome metrics: the numbers that prove the safety model is working
 * (MTTD/MTTR, rollback rate, human-approval rate, cost per incident).
 * Data-source queries are stubbed; they wire to incident/error tables in
 * Phase 2, and raw gauges are still published via Prometheus.
 */
export class MetricsCollector {
  /**
   * Collect product metrics for the given window.
   */
  collectProductMetrics(_startDate: Date, _endDate: Date): ProductMetrics {
    const incidents = this.getIncidents();
    const remediations = this.getRemediations();
    const businessData = this.getBusinessData();

    return {
      incidentsDetected: incidents.length,
      meanTimeToDetect: this.calculateMeanTimeToDetect(incidents),
      meanTimeToResolve: this.calculateMeanTimeToResolve(remediations),
      correctDiagnosisRate: this.calculateCorrectDiagnosisRate(remediations),
      successfulRemediationRate: this.calculateSuccessRate(remediations),
      rollbackRate: this.calculateRollbackRate(remediations),
      falsePositiveRate: this.calculateFalsePositiveRate(incidents),
      humanApprovalRate: this.calculateApprovalRate(remediations),
      costPerIncident: this.calculateCostPerIncident(incidents),
      tokensPerTask: this.calculateTokensPerTask(remediations),
      toolCallsPerTask: this.calculateToolCallsPerTask(remediations),
      customerRetention: businessData.retention,
      revenuePerAccount: businessData.revenuePerAccount,
    };
  }

  /**
   * Collect agent metrics for the given window.
   */
  collectAgentMetrics(_startDate: Date, _endDate: Date): AgentMetrics {
    const tasks = this.getTasks();

    return {
      averageResponseTime: this.calculateAverageResponseTime(tasks),
      throughput: this.calculateThroughput(tasks, _startDate, _endDate),
      successRate: this.calculateTaskSuccessRate(tasks),
      confidenceScore: this.calculateAverageConfidence(tasks),
      hallucinationRate: this.calculateHallucinationRate(tasks),
      contextAccuracy: this.calculateContextAccuracy(tasks),
      costPerTask: this.calculateCostPerTask(tasks),
      tokensPerResponse: this.calculateTokensPerResponse(tasks),
      toolUseCount: this.calculateToolUseCount(tasks),
    };
  }

  /**
   * Publish a metric to the shared Prometheus registry (creates/reuses a
   * gauge named `mantior_<name>`).
   */
  recordMetric(name: string, value: number, labels?: Record<string, string>): void {
    const fullName = `mantior_${name}`;
    const labelKeys = Object.keys(labels ?? {});
    let gauge = mantiorRegister.getSingleMetric(fullName) as unknown as
      client.Gauge<string> | undefined;
    if (!gauge) {
      gauge = new client.Gauge({
        name: fullName,
        help: `Mantior metric: ${name}`,
        labelNames: labelKeys,
        registers: [mantiorRegister],
      });
    }
    if (labels && labelKeys.length > 0) {
      gauge.set(labels, value);
    } else {
      gauge.set(value);
    }
    logger.debug({ name, value }, 'Metric recorded');
  }

  // ──────────────────────────────────────────────
  // DATA SOURCES (stubs — wired to tables in Phase 2)
  // ──────────────────────────────────────────────

  private getIncidents(): IncidentRecord[] {
    return [];
  }

  private getRemediations(): RemediationRecord[] {
    return [];
  }

  private getBusinessData(): BusinessData {
    return { retention: 95, revenuePerAccount: 5000 };
  }

  private getTasks(): TaskRecord[] {
    return [];
  }

  // ──────────────────────────────────────────────
  // CALCULATION HELPERS
  // ──────────────────────────────────────────────

  private calculateMeanTimeToDetect(incidents: IncidentRecord[]): number {
    if (incidents.length === 0) {
      return 0;
    }
    const total = incidents.reduce(
      (sum, incident) => sum + (incident.detectedAt - incident.occurredAt),
      0,
    );
    return total / incidents.length / 60_000; // Convert to minutes
  }

  private calculateMeanTimeToResolve(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const total = remediations.reduce((sum, r) => sum + (r.resolvedAt - r.startedAt), 0);
    return total / remediations.length / 60_000;
  }

  private calculateCorrectDiagnosisRate(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const correct = remediations.filter(r => r.diagnosisCorrect).length;
    return (correct / remediations.length) * 100;
  }

  private calculateSuccessRate(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const successful = remediations.filter(r => r.successful).length;
    return (successful / remediations.length) * 100;
  }

  private calculateRollbackRate(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const rolledBack = remediations.filter(r => r.rolledBack).length;
    return (rolledBack / remediations.length) * 100;
  }

  private calculateFalsePositiveRate(incidents: IncidentRecord[]): number {
    if (incidents.length === 0) {
      return 0;
    }
    const falsePositives = incidents.filter(incident => incident.falsePositive).length;
    return (falsePositives / incidents.length) * 100;
  }

  private calculateApprovalRate(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const approved = remediations.filter(r => r.approved).length;
    return (approved / remediations.length) * 100;
  }

  private calculateCostPerIncident(incidents: IncidentRecord[]): number {
    if (incidents.length === 0) {
      return 0;
    }
    const total = incidents.reduce((sum, incident) => sum + (incident.cost ?? 0), 0);
    return total / incidents.length;
  }

  private calculateTokensPerTask(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const total = remediations.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0);
    return total / remediations.length;
  }

  private calculateToolCallsPerTask(remediations: RemediationRecord[]): number {
    if (remediations.length === 0) {
      return 0;
    }
    const total = remediations.reduce((sum, r) => sum + (r.toolCalls ?? 0), 0);
    return total / remediations.length;
  }

  private calculateAverageResponseTime(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const total = tasks.reduce((sum, task) => sum + (task.duration ?? 0), 0);
    return total / tasks.length;
  }

  private calculateThroughput(tasks: TaskRecord[], startDate: Date, endDate: Date): number {
    const hours = (endDate.getTime() - startDate.getTime()) / (1_000 * 60 * 60);
    if (hours === 0) {
      return 0;
    }
    return tasks.length / hours;
  }

  private calculateTaskSuccessRate(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    // Task records carry no explicit success flag (stub); neutral default.
    return 0;
  }

  private calculateAverageConfidence(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const total = tasks.reduce((sum, task) => sum + (task.confidence ?? 0), 0);
    return total / tasks.length;
  }

  private calculateHallucinationRate(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const hallucinations = tasks.filter(task => task.hallucination).length;
    return (hallucinations / tasks.length) * 100;
  }

  private calculateContextAccuracy(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const accurate = tasks.filter(task => task.contextAccurate).length;
    return (accurate / tasks.length) * 100;
  }

  private calculateCostPerTask(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const total = tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0);
    return total / tasks.length;
  }

  private calculateTokensPerResponse(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const total = tasks.reduce((sum, task) => sum + (task.tokensPerResponse ?? 0), 0);
    return total / tasks.length;
  }

  private calculateToolUseCount(tasks: TaskRecord[]): number {
    if (tasks.length === 0) {
      return 0;
    }
    const total = tasks.reduce((sum, task) => sum + (task.toolCalls ?? 0), 0);
    return total / tasks.length;
  }
}

export const metricsCollector = new MetricsCollector();
