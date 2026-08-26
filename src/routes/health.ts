import { Router } from 'express';
import { one } from '../db/client.js';
import { config } from '../config.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

/**
 * Probes the database rather than just reporting that the process is up: a
 * server that cannot reach its SQLite file is not healthy, however well it
 * answers HTTP.
 */
healthRouter.get('/health', (_req, res) => {
  let database: { ok: boolean; items?: number; error?: string };
  try {
    const row = one<{ total: number }>('SELECT COUNT(*) AS total FROM items');
    database = { ok: true, items: row?.total ?? 0 };
  } catch (err) {
    database = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    env: config.env,
    database,
  });
});
