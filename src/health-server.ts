import type { Server } from 'node:http';

import express from 'express';

import { logger } from './logger';
import { metricsContent } from './metrics';
import { MantiorDatabase } from './state/database';
import { getVersion } from './version';
import { setupWebhookRoutes } from './webhook/handler';

/**
 * Express app exposing liveness (/health), readiness (/ready), Prometheus
 * metrics (/metrics) and the verified webhook receiver (/webhook).
 */
export function createApp(): express.Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: getVersion() });
  });

  app.get('/ready', (_req, res) => {
    let ready = true;
    try {
      MantiorDatabase.getInstance().getLatestScan();
    } catch {
      ready = false;
    }
    if (!ready) {
      res.status(503).json({ status: 'not_ready' });
      return;
    }
    res.json({ status: 'ready' });
  });

  app.get('/metrics', async (_req, res) => {
    res.type('text/plain; version=0.0.4');
    const content = await metricsContent();
    res.send(content);
  });

  setupWebhookRoutes(app);
  return app;
}

export function startHealthServer(port = Number(process.env.HEALTH_PORT ?? '8080')): Server {
  const app = createApp();
  const server = app.listen(port, () => {
    logger.info({ port }, 'Mantior health server listening');
  });
  return server;
}
