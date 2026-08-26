import { all, batch, one, run, statement, type Db, type SqlValue } from '../db/d1';
import { HttpError } from '../errors';
import type { Item, ItemWithStock } from '../types';

interface ItemRow {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  unit_cost_cents: number;
  reorder_point: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface ItemStockRow extends ItemRow {
  on_hand: number;
}

/**
 * Every read joins the per-item total from the ledger, because an item row on
 * its own answers almost no question anyone asks of an inventory system.
 */
const SELECT_WITH_STOCK = `
  SELECT i.*, COALESCE(s.on_hand, 0) AS on_hand
  FROM items i
  LEFT JOIN (
    SELECT item_id, SUM(quantity) AS on_hand FROM movements GROUP BY item_id
  ) s ON s.item_id = i.id
`;

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    unit: row.unit,
    unitCost: row.unit_cost_cents / 100,
    reorderPoint: row.reorder_point,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItemWithStock(row: ItemStockRow): ItemWithStock {
  const item = toItem(row);
  return {
    ...item,
    onHand: row.on_hand,
    stockValue: Math.round(row.on_hand * row.unit_cost_cents) / 100,
    lowStock: row.on_hand <= row.reorder_point,
  };
}

export interface ItemFilters {
  /** Free text over sku, name, description and category. */
  q?: string;
  category?: string;
  /** Only items at or below their reorder point. */
  lowStock: boolean;
  includeArchived: boolean;
  sort: 'sku' | 'name' | 'onHand' | 'updated';
  offset: number;
  limit: number;
}

const SORTS: Record<ItemFilters['sort'], string> = {
  sku: 'i.sku COLLATE NOCASE ASC',
  name: 'i.name COLLATE NOCASE ASC',
  onHand: 'on_hand ASC, i.sku COLLATE NOCASE ASC',
  updated: 'i.updated_at DESC, i.id DESC',
};

/** Builds the shared WHERE clause for listing and counting. */
function whereFor(filters: ItemFilters): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (!filters.includeArchived) clauses.push('i.archived = 0');

  if (filters.q !== undefined) {
    clauses.push(`(
      i.sku LIKE ? ESCAPE '\\' OR i.name LIKE ? ESCAPE '\\' OR
      i.description LIKE ? ESCAPE '\\' OR i.category LIKE ? ESCAPE '\\'
    )`);
    // A user searching for "50%" means the characters, not a wildcard.
    const pattern = `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (filters.category !== undefined) {
    clauses.push('i.category = ? COLLATE NOCASE');
    params.push(filters.category);
  }

  if (filters.lowStock) clauses.push('COALESCE(s.on_hand, 0) <= i.reorder_point');

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function listItems(
  db: Db,
  filters: ItemFilters,
): Promise<{ total: number; items: ItemWithStock[] }> {
  const where = whereFor(filters);

  // One round trip for the page and its total, instead of two.
  const [totals, page] = await db.batch<Record<string, unknown>>([
    statement(
      db,
      `SELECT COUNT(*) AS total FROM items i
       LEFT JOIN (SELECT item_id, SUM(quantity) AS on_hand FROM movements GROUP BY item_id) s
         ON s.item_id = i.id
       ${where.sql}`,
      ...where.params,
    ),
    statement(
      db,
      `${SELECT_WITH_STOCK} ${where.sql} ORDER BY ${SORTS[filters.sort]} LIMIT ? OFFSET ?`,
      ...where.params,
      filters.limit,
      filters.offset,
    ),
  ]);

  const total = Number((totals?.results[0] as { total?: number } | undefined)?.total ?? 0);
  const rows = (page?.results ?? []) as unknown as ItemStockRow[];

  return { total, items: rows.map(toItemWithStock) };
}

export async function findItem(db: Db, id: number): Promise<ItemWithStock | undefined> {
  const row = await one<ItemStockRow>(db, `${SELECT_WITH_STOCK} WHERE i.id = ?`, id);
  return row === undefined ? undefined : toItemWithStock(row);
}

/** Throws 404 rather than returning undefined; every route wants that. */
export async function requireItem(db: Db, id: number): Promise<ItemWithStock> {
  const item = await findItem(db, id);
  if (item === undefined) throw new HttpError(404, `No item with id ${id}`);
  return item;
}

export async function findItemBySku(db: Db, sku: string): Promise<ItemWithStock | undefined> {
  const row = await one<ItemStockRow>(
    db,
    `${SELECT_WITH_STOCK} WHERE i.sku = ? COLLATE NOCASE`,
    sku,
  );
  return row === undefined ? undefined : toItemWithStock(row);
}

export async function categories(db: Db): Promise<string[]> {
  const rows = await all<{ category: string }>(
    db,
    `SELECT DISTINCT category FROM items
     WHERE category IS NOT NULL AND archived = 0
     ORDER BY category COLLATE NOCASE`,
  );
  return rows.map((row) => row.category);
}

export interface NewItem {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  unitCostCents: number;
  reorderPoint: number;
}

export async function createItem(db: Db, input: NewItem): Promise<ItemWithStock> {
  const now = new Date().toISOString();
  const { lastId } = await run(
    db,
    `INSERT INTO items
       (sku, name, description, category, unit, unit_cost_cents, reorder_point, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.sku,
    input.name,
    input.description,
    input.category,
    input.unit,
    input.unitCostCents,
    input.reorderPoint,
    now,
    now,
  );
  return requireItem(db, lastId);
}

/** Only the fields present in the patch are written. */
export interface ItemPatch {
  sku?: string;
  name?: string;
  description?: string | null;
  category?: string | null;
  unit?: string;
  unitCostCents?: number;
  reorderPoint?: number;
  archived?: boolean;
}

const PATCH_COLUMNS: Record<keyof ItemPatch, string> = {
  sku: 'sku',
  name: 'name',
  description: 'description',
  category: 'category',
  unit: 'unit',
  unitCostCents: 'unit_cost_cents',
  reorderPoint: 'reorder_point',
  archived: 'archived',
};

export async function updateItem(db: Db, id: number, patch: ItemPatch): Promise<ItemWithStock> {
  await requireItem(db, id);

  const assignments: string[] = [];
  const params: SqlValue[] = [];

  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof ItemPatch, string][]) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  if (assignments.length === 0) throw new HttpError(400, 'No fields to update');

  assignments.push('updated_at = ?');
  params.push(new Date().toISOString(), id);

  await run(db, `UPDATE items SET ${assignments.join(', ')} WHERE id = ?`, ...params);
  return requireItem(db, id);
}

export async function countMovementsForItem(db: Db, id: number): Promise<number> {
  const row = await one<{ total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM movements WHERE item_id = ?',
    id,
  );
  return row?.total ?? 0;
}

/**
 * Deletes the item and its ledger rows in one transaction. The movements are
 * removed explicitly rather than left to ON DELETE CASCADE, so the count we
 * report is the count that was actually deleted.
 *
 * Callers check for history first and steer towards archiving — this is the one
 * operation here that destroys the audit trail.
 */
export async function deleteItem(db: Db, id: number): Promise<number> {
  const [movements, items] = await batch(db, [
    statement(db, 'DELETE FROM movements WHERE item_id = ?', id),
    statement(db, 'DELETE FROM items WHERE id = ?', id),
  ]);

  if ((items?.changes ?? 0) === 0) throw new HttpError(404, `No item with id ${id}`);
  return movements?.changes ?? 0;
}
