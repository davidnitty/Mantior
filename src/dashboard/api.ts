import express, { type Request } from 'express';

import { AuditLogger } from '../audit/logger';
import { metrics, register } from '../monitoring/metrics';
import { workflowEngine } from '../orchestration/workflow';
import { PolicyEngine } from '../policy/engine';

const router = express.Router();

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function queryInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(queryString(value) ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

interface AuthenticatedRequest extends Request {
  user?: { id?: string };
}

// ──────────────────────────────────────────────
// GET /api/audit
// ──────────────────────────────────────────────

router.get('/audit', (req, res) => {
  const audit = new AuditLogger();
  try {
    const results = audit.search({
      action: queryString(req.query.action),
      userId: queryString(req.query.userId),
      startDate: queryString(req.query.startDate),
      endDate: queryString(req.query.endDate),
      limit: queryInt(req.query.limit, 100),
      offset: queryInt(req.query.offset, 0),
    });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// GET /api/audit/export
// ──────────────────────────────────────────────

router.get('/audit/export', (req, res) => {
  const audit = new AuditLogger();
  try {
    const format = queryString(req.query.format) === 'csv' ? 'csv' : 'json';
    const data = audit.export({
      format,
      startDate: queryString(req.query.startDate),
      endDate: queryString(req.query.endDate),
    });
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=audit.${format}`);
    res.send(data);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// GET /api/workflows
// ──────────────────────────────────────────────

router.get('/workflows', (_req, res) => {
  try {
    res.json(workflowEngine.listWorkflows());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// GET /api/workflows/:id
// ──────────────────────────────────────────────

router.get('/workflows/:id', (req, res) => {
  try {
    const status = workflowEngine.getStatus(req.params.id);
    if (!status) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// POST /api/workflows/:id/approve | reject
// ──────────────────────────────────────────────

router.post('/workflows/:id/approve', (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const stepId = typeof body?.stepId === 'string' ? body.stepId : undefined;
  if (!stepId) {
    res.status(400).json({ error: 'stepId is required' });
    return;
  }
  try {
    const user = (req as AuthenticatedRequest).user;
    workflowEngine.approve(req.params.id, stepId, user?.id ?? 'unknown');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

router.post('/workflows/:id/reject', (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const stepId = typeof body?.stepId === 'string' ? body.stepId : undefined;
  if (!stepId) {
    res.status(400).json({ error: 'stepId is required' });
    return;
  }
  try {
    const user = (req as AuthenticatedRequest).user;
    workflowEngine.reject(req.params.id, stepId, user?.id ?? 'unknown');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// GET /api/metrics (monitoring registry, incl. default metrics)
// ──────────────────────────────────────────────

router.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ──────────────────────────────────────────────
// GET /api/policies
// ──────────────────────────────────────────────

router.get('/policies', (_req, res) => {
  try {
    const engine = new PolicyEngine();
    res.json(engine.getPolicies());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

export { router, metrics };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
