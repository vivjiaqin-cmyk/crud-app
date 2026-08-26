import { Router } from 'express';
import { requireItem } from '../data/items.js';
import { requireLocation } from '../data/locations.js';
import { listStock, lowStock, stockForItem, summary } from '../data/stock.js';
import { boolParam, idParam, intParam, optionalIdParam } from '../query.js';

export const stockRouter: Router = Router();

/**
 * GET /stock?item=12&location=3&includeZero
 *
 * On-hand per item per location, derived from the ledger. Netted-out pairs are
 * hidden unless asked for.
 */
stockRouter.get('/stock', (req, res) => {
  const itemId = optionalIdParam(req.query['item'], 'item');
  const locationId = optionalIdParam(req.query['location'], 'location');

  if (itemId !== undefined) requireItem(itemId);
  if (locationId !== undefined) requireLocation(locationId);

  const levels = listStock({
    ...(itemId !== undefined ? { itemId } : {}),
    ...(locationId !== undefined ? { locationId } : {}),
    includeZero: boolParam(req.query['includeZero'], 'includeZero'),
  });

  res.json({ count: levels.length, levels });
});

/** GET /stock/low?limit=50 — the reorder list, biggest shortfall first. */
stockRouter.get('/stock/low', (req, res) => {
  const limit = intParam(req.query['limit'], 'limit', 50, 1, 500);
  const lines = lowStock(limit);
  res.json({ count: lines.length, items: lines });
});

/** GET /stock/summary — the dashboard tiles in one call. */
stockRouter.get('/stock/summary', (_req, res) => {
  res.json(summary());
});

/** GET /items/:id/stock — where one item is sitting. */
stockRouter.get('/items/:id/stock', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const item = requireItem(id);
  const includeZero = boolParam(req.query['includeZero'], 'includeZero');

  res.json({
    item: { id: item.id, sku: item.sku, name: item.name, unit: item.unit },
    onHand: item.onHand,
    reorderPoint: item.reorderPoint,
    lowStock: item.lowStock,
    byLocation: stockForItem(id, includeZero),
  });
});
