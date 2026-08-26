import { Hono } from 'hono';
import {
  ABSENT,
  integer,
  jsonBody,
  money,
  nullableString,
  optionalString,
  rejectUnknown,
  requiredString,
  boolean as bodyBoolean,
} from '../body';
import {
  categories,
  countMovementsForItem,
  createItem,
  deleteItem,
  findItemBySku,
  listItems,
  requireItem,
  updateItem,
  type ItemPatch,
} from '../data/items';
import { listMovements } from '../data/movements';
import { stockForItem } from '../data/stock';
import { guard } from '../db/constraints';
import type { AppEnv } from '../env';
import { HttpError } from '../errors';
import { boolParam, enumParam, idParam, intParam, optionalString as queryString } from '../query';

export const items = new Hono<AppEnv>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUANTITY = 1_000_000;

const FIELDS = [
  'sku',
  'name',
  'description',
  'category',
  'unit',
  'unitCost',
  'reorderPoint',
] as const;

const SORTS = ['sku', 'name', 'onHand', 'updated'] as const;

const SKU_TAKEN = { sku: 'An item with that SKU already exists' };

/**
 * GET /items
 *   ?q=widget             free text over sku, name, description, category
 *   ?category=Fasteners
 *   ?lowStock             only items at or below their reorder point
 *   ?archived             include archived items
 *   ?sort=sku|name|onHand|updated
 *   ?offset=0&limit=50
 */
items.get('/items', async (c) => {
  const q = queryString(c.req.query('q'), 'q');
  const category = queryString(c.req.query('category'), 'category');

  const { total, items: rows } = await listItems(c.env.DB, {
    // Spread rather than assign: exactOptionalPropertyTypes means an explicit
    // `q: undefined` is not the same thing as "no filter".
    ...(q !== undefined ? { q } : {}),
    ...(category !== undefined ? { category } : {}),
    lowStock: boolParam(c.req.query('lowStock'), 'lowStock'),
    includeArchived: boolParam(c.req.query('archived'), 'archived'),
    sort: enumParam(c.req.query('sort'), 'sort', SORTS) ?? 'sku',
    offset: intParam(c.req.query('offset'), 'offset', 0, 0, 1_000_000),
    limit: intParam(c.req.query('limit'), 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
  });

  return c.json({ total, count: rows.length, items: rows });
});

/** GET /items/categories — for populating a filter dropdown. */
items.get('/items/categories', async (c) => {
  return c.json({ categories: await categories(c.env.DB) });
});

/** GET /items/:id — the item, where its stock sits, and its recent movements. */
items.get('/items/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const item = await requireItem(c.env.DB, id);
  const [byLocation, ledger] = await Promise.all([
    stockForItem(c.env.DB, id),
    listMovements(c.env.DB, { itemId: id, offset: 0, limit: 20 }),
  ]);

  return c.json({ ...item, byLocation, recentMovements: ledger.movements });
});

/**
 * POST /items
 *
 * Creates the item only. Stock arrives through the ledger, so a new item starts
 * at zero on hand and its first receipt is a separate, dated record.
 */
items.post('/items', async (c) => {
  const body = await jsonBody(c.req);
  rejectUnknown(body, FIELDS);

  const sku = requiredString(body, 'sku', 64);
  if ((await findItemBySku(c.env.DB, sku)) !== undefined) {
    throw new HttpError(409, `An item with SKU "${sku}" already exists`);
  }

  const description = nullableString(body, 'description');
  const category = nullableString(body, 'category', 80);
  const unit = optionalString(body, 'unit', 24);
  const unitCostCents = money(body, 'unitCost');
  const reorderPoint = integer(body, 'reorderPoint', 0, MAX_QUANTITY);

  const item = await guard(SKU_TAKEN, () =>
    createItem(c.env.DB, {
      sku,
      name: requiredString(body, 'name'),
      description: description === ABSENT ? null : description,
      category: category === ABSENT ? null : category,
      unit: unit === ABSENT ? 'each' : unit,
      unitCostCents: unitCostCents === ABSENT ? 0 : unitCostCents,
      reorderPoint: reorderPoint === ABSENT ? 0 : reorderPoint,
    }),
  );

  c.header('Location', `/items/${item.id}`);
  return c.json(item, 201);
});

/**
 * PATCH /items/:id
 *
 * Partial update: absent fields are left alone, and null clears description and
 * category. There is deliberately no quantity field — stock changes are
 * movements, not edits.
 */
items.patch('/items/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const body = await jsonBody(c.req);
  rejectUnknown(body, [...FIELDS, 'archived']);

  const patch: ItemPatch = {};

  const sku = optionalString(body, 'sku', 64);
  if (sku !== ABSENT) {
    const clash = await findItemBySku(c.env.DB, sku);
    if (clash !== undefined && clash.id !== id) {
      throw new HttpError(409, `An item with SKU "${sku}" already exists`);
    }
    patch.sku = sku;
  }

  const name = optionalString(body, 'name');
  if (name !== ABSENT) patch.name = name;

  const description = nullableString(body, 'description');
  if (description !== ABSENT) patch.description = description;

  const category = nullableString(body, 'category', 80);
  if (category !== ABSENT) patch.category = category;

  const unit = optionalString(body, 'unit', 24);
  if (unit !== ABSENT) patch.unit = unit;

  const unitCostCents = money(body, 'unitCost');
  if (unitCostCents !== ABSENT) patch.unitCostCents = unitCostCents;

  const reorderPoint = integer(body, 'reorderPoint', 0, MAX_QUANTITY);
  if (reorderPoint !== ABSENT) patch.reorderPoint = reorderPoint;

  const archived = bodyBoolean(body, 'archived');
  if (archived !== ABSENT) patch.archived = archived;

  return c.json(await guard(SKU_TAKEN, () => updateItem(c.env.DB, id, patch)));
});

/**
 * DELETE /items/:id
 *
 * Refuses while the item has ledger history, and points at archiving instead;
 * ?force=true takes the movements down with it. Losing the history is usually
 * worse than a longer item list, so the default is the cautious one.
 */
items.delete('/items/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const force = boolParam(c.req.query('force'), 'force');
  const item = await requireItem(c.env.DB, id);
  const history = await countMovementsForItem(c.env.DB, id);

  if (history > 0 && !force) {
    throw new HttpError(
      409,
      `Item ${item.sku} has ${history} movement${history === 1 ? '' : 's'}. ` +
        'Archive it with PATCH {"archived":true} to keep the history, or repeat with ?force=true to delete both.',
    );
  }

  const movementsDeleted = await deleteItem(c.env.DB, id);
  return c.json({ deleted: { id, sku: item.sku }, movementsDeleted });
});
