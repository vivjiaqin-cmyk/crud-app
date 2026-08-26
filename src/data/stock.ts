import { all, one, type Db, type SqlValue } from '../db/d1';
import type { StockLevel } from '../types';

/**
 * Reads over the stock_levels view: on-hand per item per location, plus the two
 * roll-ups the UI actually shows — the low-stock list and the totals tiles.
 *
 * Zero balances are dropped by default. A row that says "0 widgets in WH-B" is
 * only interesting when you are looking at that pair on purpose, and including
 * them everywhere would bury the real stock in history.
 */

interface StockRow {
  item_id: number;
  sku: string;
  item_name: string;
  unit: string;
  location_id: number;
  location_code: string;
  location_name: string;
  on_hand: number;
}

const SELECT_STOCK = `
  SELECT s.item_id, s.location_id, s.on_hand,
         i.sku  AS sku,
         i.name AS item_name,
         i.unit AS unit,
         l.code AS location_code,
         l.name AS location_name
  FROM stock_levels s
  JOIN items i     ON i.id = s.item_id
  JOIN locations l ON l.id = s.location_id
`;

function toStockLevel(row: StockRow): StockLevel {
  return {
    itemId: row.item_id,
    sku: row.sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    onHand: row.on_hand,
    unit: row.unit,
  };
}

export interface StockFilters {
  itemId?: number;
  locationId?: number;
  /** Include item/location pairs that have netted back to zero. */
  includeZero: boolean;
}

export async function listStock(db: Db, filters: StockFilters): Promise<StockLevel[]> {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (filters.itemId !== undefined) {
    clauses.push('s.item_id = ?');
    params.push(filters.itemId);
  }
  if (filters.locationId !== undefined) {
    clauses.push('s.location_id = ?');
    params.push(filters.locationId);
  }
  if (!filters.includeZero) clauses.push('s.on_hand <> 0');

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await all<StockRow>(
    db,
    `${SELECT_STOCK} ${where} ORDER BY i.sku COLLATE NOCASE, l.code COLLATE NOCASE`,
    ...params,
  );
  return rows.map(toStockLevel);
}

/** Where one item is sitting, nothing else. */
export function stockForItem(db: Db, itemId: number, includeZero = false): Promise<StockLevel[]> {
  return listStock(db, { itemId, includeZero });
}

export interface LowStockLine {
  itemId: number;
  sku: string;
  name: string;
  unit: string;
  onHand: number;
  reorderPoint: number;
  /** How many units to buy to get back to the reorder point. */
  shortBy: number;
}

/**
 * Items at or below their reorder point, worst first. Archived items are left
 * out: nobody wants a purchase order for something they stopped stocking.
 */
export async function lowStock(db: Db, limit = 50): Promise<LowStockLine[]> {
  const rows = await all<{
    id: number;
    sku: string;
    name: string;
    unit: string;
    on_hand: number;
    reorder_point: number;
  }>(
    db,
    `SELECT i.id, i.sku, i.name, i.unit, i.reorder_point,
            COALESCE(s.on_hand, 0) AS on_hand
     FROM items i
     LEFT JOIN (SELECT item_id, SUM(quantity) AS on_hand FROM movements GROUP BY item_id) s
       ON s.item_id = i.id
     WHERE i.archived = 0 AND COALESCE(s.on_hand, 0) <= i.reorder_point
     ORDER BY (COALESCE(s.on_hand, 0) - i.reorder_point) ASC, i.sku COLLATE NOCASE
     LIMIT ?`,
    limit,
  );

  return rows.map((row) => ({
    itemId: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    onHand: row.on_hand,
    reorderPoint: row.reorder_point,
    shortBy: Math.max(0, row.reorder_point - row.on_hand),
  }));
}

export interface StockSummary {
  items: number;
  archivedItems: number;
  locations: number;
  movements: number;
  unitsOnHand: number;
  /** On-hand valued at each item's unit cost. */
  stockValue: number;
  lowStockItems: number;
}

export async function summary(db: Db): Promise<StockSummary> {
  const row = await one<{
    items: number;
    archived_items: number;
    locations: number;
    movements: number;
    units_on_hand: number;
    value_cents: number;
    low_stock_items: number;
  }>(
    db,
    `WITH per_item AS (
       SELECT i.id, i.archived, i.unit_cost_cents, i.reorder_point,
              COALESCE(SUM(m.quantity), 0) AS on_hand
       FROM items i
       LEFT JOIN movements m ON m.item_id = i.id
       GROUP BY i.id
     )
     SELECT
       (SELECT COUNT(*) FROM items WHERE archived = 0) AS items,
       (SELECT COUNT(*) FROM items WHERE archived = 1) AS archived_items,
       (SELECT COUNT(*) FROM locations)                AS locations,
       (SELECT COUNT(*) FROM movements)                AS movements,
       COALESCE(SUM(on_hand), 0)                       AS units_on_hand,
       COALESCE(SUM(on_hand * unit_cost_cents), 0)     AS value_cents,
       COALESCE(SUM(CASE WHEN archived = 0 AND on_hand <= reorder_point THEN 1 ELSE 0 END), 0)
                                                       AS low_stock_items
     FROM per_item`,
  );

  return {
    items: row?.items ?? 0,
    archivedItems: row?.archived_items ?? 0,
    locations: row?.locations ?? 0,
    movements: row?.movements ?? 0,
    unitsOnHand: row?.units_on_hand ?? 0,
    stockValue: (row?.value_cents ?? 0) / 100,
    lowStockItems: row?.low_stock_items ?? 0,
  };
}
