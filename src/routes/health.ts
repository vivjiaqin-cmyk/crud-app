import { Hono } from 'hono';
import { one } from '../db/d1';
import type { AppEnv } from '../env';

export const health = new Hono<AppEnv>();

/**
 * Probes D1 rather than just reporting that the Worker ran: an isolate that
 * cannot reach its database is not healthy, however well it answers HTTP.
 *
 * There is no uptime to report — a Worker isolate is created and discarded
 * around requests, so the only meaningful liveness signal is the query.
 */
health.get('/health', async (c) => {
  const started = Date.now();
  let database: { ok: boolean; items?: number; queryMs?: number; error?: string };

  try {
    const row = await one<{ total: number }>(c.env.DB, 'SELECT COUNT(*) AS total FROM items');
    database = { ok: true, items: row?.total ?? 0, queryMs: Date.now() - started };
  } catch (err) {
    database = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  return c.json(
    { status: database.ok ? 'ok' : 'degraded', now: new Date().toISOString(), database },
    database.ok ? 200 : 503,
  );
});
