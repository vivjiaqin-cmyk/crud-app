import { Router } from 'express';
import {
  ABSENT,
  asObject,
  integer,
  money,
  nullableString,
  optionalString,
  rejectUnknown,
  requiredString,
  boolean as bodyBoolean,
} from '../body.js';
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
} from '../data/items.js';
import { stockForItem } from '../data/stock.js';
import { listMovements } from '../data/movements.js';
import { guard } from '../db/constraints.js';
import { HttpError } from '../middleware/errors.js';
import { boolParam, enumParam, idParam, intParam, optionalString as queryString } from '../query.js';

export const itemsRouter: Router = Router();

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
itemsRouter.get('/items', (req, res) => {
  const q = queryString(req.query['q'], 'q');
  const category = queryString(req.query['category'], 'category');

  const { total, items } = listItems({
    // Spread rather than assign: exactOptionalPropertyTypes means an explicit
    // `q: undefined` is not the same thing as "no filter".
    ...(q !== undefined ? { q } : {}),
    ...(category !== undefined ? { category } : {}),
    lowStock: boolParam(req.query['lowStock'], 'lowStock'),
    includeArchived: boolParam(req.query['archived'], 'archived'),
    sort: enumParam(req.query['sort'], 'sort', SORTS) ?? 'sku',
    offset: intParam(req.query['offset'], 'offset', 0, 0, 1_000_000),
    limit: intParam(req.query['limit'], 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
  });

  res.json({ total, count: items.length, items });
});

/** GET /items/categories — for populating a filter dropdown. */
itemsRouter.get('/items/categories', (_req, res) => {
  res.json({ categories: categories() });
});

/** GET /items/:id — the item, where its stock sits, and its recent movements. */
itemsRouter.get('/items/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const item = requireItem(id);
  const { movements } = listMovements({ itemId: id, offset: 0, limit: 20 });

  res.json({ ...item, byLocation: stockForItem(id), recentMovements: movements });
});

/**
 * POST /items
 *
 * Creates the item only. Stock arrives through the ledger, so a new item starts
 * at zero on hand and its first receipt is a separate, dated record.
 */
itemsRouter.post('/items', (req, res) => {
  const body = asObject(req.body);
  rejectUnknown(body, FIELDS);

  const sku = requiredString(body, 'sku', 64);
  if (findItemBySku(sku) !== undefined) {
    throw new HttpError(409, `An item with SKU "${sku}" already exists`);
  }

  const description = nullableString(body, 'description');
  const category = nullableString(body, 'category', 80);
  const unit = optionalString(body, 'unit', 24);
  const unitCostCents = money(body, 'unitCost');
  const reorderPoint = integer(body, 'reorderPoint', 0, MAX_QUANTITY);

  const item = guard(SKU_TAKEN, () =>
    createItem({
      sku,
      name: requiredString(body, 'name'),
      description: description === ABSENT ? null : description,
      category: category === ABSENT ? null : category,
      unit: unit === ABSENT ? 'each' : unit,
      unitCostCents: unitCostCents === ABSENT ? 0 : unitCostCents,
      reorderPoint: reorderPoint === ABSENT ? 0 : reorderPoint,
    }),
  );

  res.status(201).location(`/items/${item.id}`).json(item);
});

/**
 * PATCH /items/:id
 *
 * Partial update: absent fields are left alone, and null clears description and
 * category. There is deliberately no quantity field — stock changes are
 * movements, not edits.
 */
itemsRouter.patch('/items/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const body = asObject(req.body);
  rejectUnknown(body, [...FIELDS, 'archived']);

  const patch: ItemPatch = {};

  const sku = optionalString(body, 'sku', 64);
  if (sku !== ABSENT) {
    const clash = findItemBySku(sku);
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

  res.json(guard(SKU_TAKEN, () => updateItem(id, patch)));
});

/**
 * DELETE /items/:id
 *
 * Refuses while the item has ledger history, and points at archiving instead;
 * ?force=true takes the movements down with it. Losing the history is usually
 * worse than a longer item list, so the default is the cautious one.
 */
itemsRouter.delete('/items/:id', (req, res) => {
  const id = idParam(req.params['id'], 'id');
  const force = boolParam(req.query['force'], 'force');
  const item = requireItem(id);
  const history = countMovementsForItem(id);

  if (history > 0 && !force) {
    throw new HttpError(
      409,
      `Item ${item.sku} has ${history} movement${history === 1 ? '' : 's'}. ` +
        'Archive it with PATCH {"archived":true} to keep the history, or repeat with ?force=true to delete both.',
    );
  }

  deleteItem(id);
  res.json({ deleted: { id, sku: item.sku }, movementsDeleted: force ? history : 0 });
});
