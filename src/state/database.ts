import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { logger } from '../logger';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export interface ScanRecord {
  id: number;
  timestamp: string;
  duration: number;
  changes_detected: number;
  consumers_scanned: number;
  prs_opened: number;
  errors_count: number;
  status: 'success' | 'failed' | 'partial';
  config_hash: string;
}

export interface PRRecord {
  id: number;
  scan_id: number;
  repo: string;
  pr_url: string;
  pr_number: number;
  branch: string;
  status: 'open' | 'merged' | 'closed';
  created_at: string;
  merged_at?: string;
  changes: string;
}

export interface ErrorRecord {
  id: number;
  scan_id: number;
  timestamp: string;
  module: string;
  type: string;
  message: string;
  stack?: string;
}

export interface MetricRecord {
  id: number;
  timestamp: string;
  name: string;
  value: number;
  labels: string;
}

export interface AutonomyLog {
  id: number;
  timestamp: string;
  scan_id: number;
  change_type: string;
  change_message: string;
  requested_level: number;
  effective_level: number;
  action_taken: string;
  confidence_score: number;
  requires_approval: boolean;
  approved?: boolean;
  approved_at?: string;
  approved_by?: string;
}

export interface AuditRecord {
  id: number;
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

export interface ConfigRecord {
  id: number;
  name: string;
  file_hash: string;
  consumers_count: number;
  created_at: string;
}

export interface ConsumerRecord {
  id: number;
  scan_id: number;
  repo: string;
  branch: string;
  language: string;
  call_sites_found: number;
  pr_opened: boolean;
  pr_url?: string;
}

export interface StatusSummary {
  totalScans: number;
  totalPRsOpened: number;
  totalChangesDetected: number;
  consumersMonitored: number;
  errorRate: number;
  latestScan?: ScanRecord;
}

export interface ActivityEntry {
  kind: 'scan' | 'pr' | 'error';
  timestamp: string;
  summary: string;
}

type InsertScan = Omit<ScanRecord, 'id'>;
type InsertPR = Omit<PRRecord, 'id'>;
type InsertError = Omit<ErrorRecord, 'id'>;
type InsertMetric = Omit<MetricRecord, 'id'>;
type InsertConfig = Omit<ConfigRecord, 'id'>;
type InsertConsumer = Omit<ConsumerRecord, 'id'>;
type InsertAutonomyLog = Omit<AutonomyLog, 'id'>;

// ──────────────────────────────────────────────
// DATABASE
// ──────────────────────────────────────────────

export class MantiorDatabase {
  private static instances = new Map<string, MantiorDatabase>();

  private readonly db: Database.Database;

  private constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
    this.migrate();
    logger.info({ dbPath }, 'Mantior database initialized');
  }

  static getInstance(dbPath?: string): MantiorDatabase {
    const path = dbPath ?? defaultDatabasePath();
    const existing = MantiorDatabase.instances.get(path);
    if (existing) {
      return existing;
    }
    const instance = new MantiorDatabase(path);
    MantiorDatabase.instances.set(path, instance);
    return instance;
  }

  close(): void {
    this.db.close();
    MantiorDatabase.instances.delete(this.dbPath);
  }

  // ──────────────────────────────────────────────
  // SCHEMA
  // ──────────────────────────────────────────────

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        duration REAL NOT NULL,
        changes_detected INTEGER NOT NULL,
        consumers_scanned INTEGER NOT NULL,
        prs_opened INTEGER NOT NULL,
        errors_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        config_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        pr_url TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        merged_at TEXT,
        changes TEXT NOT NULL,
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      );

      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        module TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        consumers_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consumers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        language TEXT NOT NULL,
        call_sites_found INTEGER NOT NULL,
        pr_opened BOOLEAN NOT NULL,
        pr_url TEXT,
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
      CREATE INDEX IF NOT EXISTS idx_prs_scan_id ON prs(scan_id);
      CREATE INDEX IF NOT EXISTS idx_prs_status ON prs(status);
      CREATE INDEX IF NOT EXISTS idx_errors_scan_id ON errors(scan_id);
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS autonomy_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        scan_id INTEGER NOT NULL,
        change_type TEXT NOT NULL,
        change_message TEXT NOT NULL,
        requested_level INTEGER NOT NULL,
        effective_level INTEGER NOT NULL,
        action_taken TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        requires_approval BOOLEAN NOT NULL,
        approved BOOLEAN,
        approved_at TEXT,
        approved_by TEXT,
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_autonomy_logs_scan_id ON autonomy_logs(scan_id);
      CREATE INDEX IF NOT EXISTS idx_autonomy_logs_timestamp ON autonomy_logs(timestamp);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        metadata TEXT NOT NULL,
        before_state TEXT,
        after_state TEXT,
        ip TEXT,
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    `);
  }

  /** Future schema updates — additive, safe to run repeatedly. */
  private migrate(): void {
    this.tryAddColumn('scans', 'config_hash', "TEXT DEFAULT ''");
    this.tryAddColumn('prs', 'changes', "TEXT DEFAULT '[]'");
  }

  private tryAddColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists — expected on warm databases.
    }
  }

  // ──────────────────────────────────────────────
  // INSERT
  // ──────────────────────────────────────────────

  insertScan(scan: InsertScan): number {
    const stmt = this.db.prepare(
      `INSERT INTO scans (timestamp, duration, changes_detected, consumers_scanned, prs_opened, errors_count, status, config_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      scan.timestamp,
      scan.duration,
      scan.changes_detected,
      scan.consumers_scanned,
      scan.prs_opened,
      scan.errors_count,
      scan.status,
      scan.config_hash,
    );
    return Number(result.lastInsertRowid);
  }

  insertPR(pr: InsertPR): number {
    const stmt = this.db.prepare(
      `INSERT INTO prs (scan_id, repo, pr_url, pr_number, branch, status, created_at, merged_at, changes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      pr.scan_id,
      pr.repo,
      pr.pr_url,
      pr.pr_number,
      pr.branch,
      pr.status,
      pr.created_at,
      pr.merged_at ?? null,
      pr.changes,
    );
    return Number(result.lastInsertRowid);
  }

  insertError(error: InsertError): number {
    const stmt = this.db.prepare(
      `INSERT INTO errors (scan_id, timestamp, module, type, message, stack)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      error.scan_id,
      error.timestamp,
      error.module,
      error.type,
      error.message,
      error.stack ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  insertMetric(metric: InsertMetric): number {
    const stmt = this.db.prepare(
      `INSERT INTO metrics (timestamp, name, value, labels)
       VALUES (?, ?, ?, ?)`,
    );
    const result = stmt.run(metric.timestamp, metric.name, metric.value, metric.labels);
    return Number(result.lastInsertRowid);
  }

  insertAutonomyLog(log: InsertAutonomyLog): number {
    const stmt = this.db.prepare(
      `INSERT INTO autonomy_logs (
         timestamp, scan_id, change_type, change_message,
         requested_level, effective_level, action_taken,
         confidence_score, requires_approval, approved,
         approved_at, approved_by
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      log.timestamp,
      log.scan_id,
      log.change_type,
      log.change_message,
      log.requested_level,
      log.effective_level,
      log.action_taken,
      log.confidence_score,
      log.requires_approval ? 1 : 0,
      log.approved ? 1 : 0,
      log.approved_at ?? null,
      log.approved_by ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  insertConfig(config: InsertConfig): number {
    const stmt = this.db.prepare(
      `INSERT INTO configs (name, file_hash, consumers_count, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const result = stmt.run(
      config.name,
      config.file_hash,
      config.consumers_count,
      config.created_at,
    );
    return Number(result.lastInsertRowid);
  }

  insertConsumer(consumer: InsertConsumer): number {
    const stmt = this.db.prepare(
      `INSERT INTO consumers (scan_id, repo, branch, language, call_sites_found, pr_opened, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      consumer.scan_id,
      consumer.repo,
      consumer.branch,
      consumer.language,
      consumer.call_sites_found,
      consumer.pr_opened ? 1 : 0,
      consumer.pr_url ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  // ──────────────────────────────────────────────
  // QUERY
  // ──────────────────────────────────────────────

  getLatestScans(limit = 10): ScanRecord[] {
    return this.db
      .prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as unknown as ScanRecord[];
  }

  getLatestScan(): ScanRecord | undefined {
    return this.db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT 1').get() as
      ScanRecord | undefined;
  }

  getPRsForScan(scanId: number): PRRecord[] {
    return this.db
      .prepare('SELECT * FROM prs WHERE scan_id = ? ORDER BY id ASC')
      .all(scanId) as unknown as PRRecord[];
  }

  getErrorsForScan(scanId: number): ErrorRecord[] {
    return this.db
      .prepare('SELECT * FROM errors WHERE scan_id = ? ORDER BY id ASC')
      .all(scanId) as unknown as ErrorRecord[];
  }

  getConsumersForScan(scanId: number): ConsumerRecord[] {
    return this.db
      .prepare('SELECT * FROM consumers WHERE scan_id = ? ORDER BY id ASC')
      .all(scanId) as unknown as ConsumerRecord[];
  }

  getRecentMetrics(limit = 50): MetricRecord[] {
    return this.db
      .prepare('SELECT * FROM metrics ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as unknown as MetricRecord[];
  }

  /** Sum of metric values with `name` recorded at or after `from` (ISO timestamp). */
  sumMetricByName(name: string, from: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(value), 0) AS total FROM metrics WHERE name = ? AND timestamp >= ?',
      )
      .get(name, from) as { total: number };
    return row.total;
  }

  /** Persisted key/value settings (e.g. autonomy level). */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  getRecentAutonomyLogs(limit = 50): AutonomyLog[] {
    return this.db
      .prepare('SELECT * FROM autonomy_logs ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as unknown as AutonomyLog[];
  }

  /** Append an immutable audit entry. */
  insertAudit(entry: {
    timestamp: string;
    action: string;
    userId?: string;
    sessionId?: string;
    metadata: Record<string, unknown>;
    before?: unknown;
    after?: unknown;
    ip?: string;
    userAgent?: string;
  }): number {
    const stmt = this.db.prepare(
      `INSERT INTO audit_logs (
         timestamp, action, user_id, session_id, metadata, before_state, after_state, ip, user_agent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      entry.timestamp,
      entry.action,
      entry.userId ?? null,
      entry.sessionId ?? null,
      JSON.stringify(entry.metadata),
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
      entry.userAgent ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Search audit entries with optional filters. */
  searchAuditLogs(params: {
    action?: string;
    userId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): AuditRecord[] {
    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (params.action) {
      conditions.push('action = ?');
      args.push(params.action);
    }
    if (params.userId) {
      conditions.push('user_id = ?');
      args.push(params.userId);
    }
    if (params.startDate) {
      conditions.push('timestamp >= ?');
      args.push(params.startDate);
    }
    if (params.endDate) {
      conditions.push('timestamp <= ?');
      args.push(params.endDate);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToAuditRecord);
  }

  /** Audit entries whose metadata contains the given key/value (e.g. workflowId). */
  getAuditByMetadataKey(key: string, value: string): AuditRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM audit_logs WHERE json_extract(metadata, ?) = ? ORDER BY timestamp ASC',
      )
      .all(`$.${key}`, value) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToAuditRecord);
  }

  getStatusSummary(): StatusSummary {
    const scan = this.getLatestScan();
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM scans) AS total_scans,
           (SELECT COALESCE(SUM(prs_opened), 0) FROM scans) AS total_prs_opened,
           (SELECT COALESCE(SUM(changes_detected), 0) FROM scans) AS total_changes_detected,
           (SELECT COUNT(DISTINCT repo) FROM consumers) AS consumers_monitored,
           (SELECT COALESCE(SUM(errors_count), 0) FROM scans) AS total_errors`,
      )
      .get() as {
      total_scans: number;
      total_prs_opened: number;
      total_changes_detected: number;
      consumers_monitored: number;
      total_errors: number;
    };

    const totalScans = counts.total_scans;
    return {
      totalScans,
      totalPRsOpened: counts.total_prs_opened,
      totalChangesDetected: counts.total_changes_detected,
      consumersMonitored: counts.consumers_monitored,
      errorRate: totalScans > 0 ? (counts.total_errors / totalScans) * 100 : 0,
      latestScan: scan,
    };
  }

  /** Unified recent activity for `mantior logs`. */
  getRecentActivity(limit = 50): ActivityEntry[] {
    const entries: ActivityEntry[] = [];
    for (const scan of this.getLatestScans(limit)) {
      entries.push({
        kind: 'scan',
        timestamp: scan.timestamp,
        summary: `Scan completed: ${scan.changes_detected} change(s), ${scan.prs_opened} PR(s), ${scan.errors_count} error(s)`,
      });
    }
    for (const pr of this.getLatestPRs(limit)) {
      entries.push({
        kind: 'pr',
        timestamp: pr.created_at,
        summary: `PR ${pr.pr_number} ${pr.status} on ${pr.repo}`,
      });
    }
    for (const error of this.getLatestErrors(limit)) {
      entries.push({
        kind: 'error',
        timestamp: error.timestamp,
        summary: `[${error.module}] ${error.message}`,
      });
    }
    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return entries.slice(0, limit);
  }

  private getLatestPRs(limit: number): PRRecord[] {
    return this.db
      .prepare('SELECT * FROM prs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as PRRecord[];
  }

  private getLatestErrors(limit: number): ErrorRecord[] {
    return this.db
      .prepare('SELECT * FROM errors ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as unknown as ErrorRecord[];
  }
}

function defaultDatabasePath(): string {
  const dir = join(homedir(), '.mantior');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'mantior.db');
}

function rowToAuditRecord(row: Record<string, unknown>): AuditRecord {
  return {
    id: Number(row.id),
    timestamp: String(row.timestamp),
    action: String(row.action),
    userId: row.user_id === null || row.user_id === undefined ? undefined : String(row.user_id),
    sessionId:
      row.session_id === null || row.session_id === undefined ? undefined : String(row.session_id),
    metadata: parseJsonObject(row.metadata),
    before:
      row.before_state === null || row.before_state === undefined
        ? undefined
        : parseJsonValue(row.before_state),
    after:
      row.after_state === null || row.after_state === undefined
        ? undefined
        : parseJsonValue(row.after_state),
    ip: row.ip === null || row.ip === undefined ? undefined : String(row.ip),
    userAgent:
      row.user_agent === null || row.user_agent === undefined ? undefined : String(row.user_agent),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return String(value);
  }
}
