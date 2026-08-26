import { Hono } from 'hono';
import { requireItem } from '../data/items';
import { requireLocation } from '../data/locations';
import { listStock, lowStock, stockForItem, summary } from '../data/stock';
import type { AppEnv } from '../env';
import { boolParam, idParam, intParam, optionalIdParam } from '../query';

export const stock = new Hono<AppEnv>();

/**
 * GET /stock?item=12&location=3&includeZero
 *
 * On-hand per item per location, derived from the ledger. Netted-out pairs are
 * hidden unless asked for.
 */
stock.get('/stock', async (c) => {
  const itemId = optionalIdParam(c.req.query('item'), 'item');
  const locationId = optionalIdParam(c.req.query('location'), 'location');

  if (itemId !== undefined) await requireItem(c.env.DB, itemId);
  if (locationId !== undefined) await requireLocation(c.env.DB, locationId);

  const levels = await listStock(c.env.DB, {
    ...(itemId !== undefined ? { itemId } : {}),
    ...(locationId !== undefined ? { locationId } : {}),
    includeZero: boolParam(c.req.query('includeZero'), 'includeZero'),
  });

  return c.json({ count: levels.length, levels });
});

/** GET /stock/low?limit=50 — the reorder list, biggest shortfall first. */
stock.get('/stock/low', async (c) => {
  const limit = intParam(c.req.query('limit'), 'limit', 50, 1, 500);
  const lines = await lowStock(c.env.DB, limit);
  return c.json({ count: lines.length, items: lines });
});

/** GET /stock/summary — the dashboard tiles in one call. */
stock.get('/stock/summary', async (c) => {
  return c.json(await summary(c.env.DB));
});

/** GET /items/:id/stock — where one item is sitting. */
stock.get('/items/:id/stock', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const item = await requireItem(c.env.DB, id);
  const includeZero = boolParam(c.req.query('includeZero'), 'includeZero');

  return c.json({
    item: { id: item.id, sku: item.sku, name: item.name, unit: item.unit },
    onHand: item.onHand,
    reorderPoint: item.reorderPoint,
    lowStock: item.lowStock,
    byLocation: await stockForItem(c.env.DB, id, includeZero),
  });
});
