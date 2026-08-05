import { logger } from '../logger';
import { MantiorDatabase } from '../state/database';

export interface AuditEntry {
  id?: number;
  timestamp: string;
  action: string;
  userId?: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

export interface AuditSearchParams {
  action?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
  metadata?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

/**
 * Immutable audit trail: every observation, decision, tool call and result is
 * recorded to SQLite (audit_logs) and the structured log stream. All writes
 * are append-only; search/export read from the same store.
 */
export class AuditLogger {
  private readonly db: MantiorDatabase;

  constructor(db = MantiorDatabase.getInstance()) {
    this.db = db;
  }

  logAction(entry: Omit<AuditEntry, 'id' | 'timestamp'>): number {
    const timestamp = new Date().toISOString();
    logger.info(
      {
        action: entry.action,
        userId: entry.userId,
        metadata: entry.metadata,
        before: entry.before,
        after: entry.after,
      },
      `Audit: ${entry.action}`,
    );
    return this.db.insertAudit({ ...entry, timestamp });
  }

  search(params: AuditSearchParams = {}): AuditEntry[] {
    return this.db
      .searchAuditLogs({
        action: params.action,
        userId: params.userId,
        startDate: params.startDate,
        endDate: params.endDate,
        limit: params.limit ?? 100,
        offset: params.offset ?? 0,
      })
      .map(toAuditEntry);
  }

  getWorkflowAudit(workflowId: string): AuditEntry[] {
    return this.db.getAuditByMetadataKey('workflowId', workflowId).map(toAuditEntry);
  }

  export(params: { format: 'json' | 'csv'; startDate?: string; endDate?: string }): string {
    const entries = this.search({
      startDate: params.startDate,
      endDate: params.endDate,
      limit: 10_000,
    });
    if (params.format === 'csv') {
      return toCsv(entries);
    }
    return JSON.stringify(entries, null, 2);
  }
}

function toAuditEntry(record: ReturnType<MantiorDatabase['searchAuditLogs']>[number]): AuditEntry {
  return { ...record };
}

function toCsv(entries: AuditEntry[]): string {
  const headers = ['timestamp', 'action', 'userId', 'metadata'];
  const rows = entries.map(entry => [
    entry.timestamp,
    entry.action,
    entry.userId ?? '',
    JSON.stringify(entry.metadata),
  ]);
  return [headers.join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
