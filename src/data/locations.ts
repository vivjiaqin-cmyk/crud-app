import { all, batch, one, run, statement, type Db, type SqlValue } from '../db/d1';
import { HttpError } from '../errors';
import type { Location, LocationKind } from '../types';

export const LOCATION_KINDS = ['warehouse', 'store', 'transit'] as const;

interface LocationRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

function toLocation(row: LocationRow): Location {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as LocationKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A location plus what is sitting in it, for the list view. */
export interface LocationWithStock extends Location {
  /** Distinct items with a non-zero balance here. */
  itemCount: number;
  /** Total units across those items. Only comparable for like units. */
  unitsOnHand: number;
}

const SELECT_WITH_STOCK = `
  SELECT l.*,
         COALESCE(s.item_count, 0)    AS item_count,
         COALESCE(s.units_on_hand, 0) AS units_on_hand
  FROM locations l
  LEFT JOIN (
    SELECT location_id,
           COUNT(*)     AS item_count,
           SUM(on_hand) AS units_on_hand
    FROM stock_levels
    WHERE on_hand <> 0
    GROUP BY location_id
  ) s ON s.location_id = l.id
`;

interface LocationStockRow extends LocationRow {
  item_count: number;
  units_on_hand: number;
}

function toLocationWithStock(row: LocationStockRow): LocationWithStock {
  return { ...toLocation(row), itemCount: row.item_count, unitsOnHand: row.units_on_hand };
}

export async function listLocations(db: Db, kind?: LocationKind): Promise<LocationWithStock[]> {
  const where = kind === undefined ? '' : 'WHERE l.kind = ?';
  const params: SqlValue[] = kind === undefined ? [] : [kind];
  const rows = await all<LocationStockRow>(
    db,
    `${SELECT_WITH_STOCK} ${where} ORDER BY l.code COLLATE NOCASE`,
    ...params,
  );
  return rows.map(toLocationWithStock);
}

export async function findLocation(db: Db, id: number): Promise<LocationWithStock | undefined> {
  const row = await one<LocationStockRow>(db, `${SELECT_WITH_STOCK} WHERE l.id = ?`, id);
  return row === undefined ? undefined : toLocationWithStock(row);
}

export async function requireLocation(
  db: Db,
  id: number,
  field = 'locationId',
): Promise<LocationWithStock> {
  const location = await findLocation(db, id);
  if (location === undefined) throw new HttpError(404, `No location with id ${id} (${field})`);
  return location;
}

export async function findLocationByCode(
  db: Db,
  code: string,
): Promise<LocationWithStock | undefined> {
  const row = await one<LocationStockRow>(
    db,
    `${SELECT_WITH_STOCK} WHERE l.code = ? COLLATE NOCASE`,
    code,
  );
  return row === undefined ? undefined : toLocationWithStock(row);
}

export interface NewLocation {
  code: string;
  name: string;
  kind: LocationKind;
}

export async function createLocation(db: Db, input: NewLocation): Promise<LocationWithStock> {
  const now = new Date().toISOString();
  const { lastId } = await run(
    db,
    'INSERT INTO locations (code, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    input.code,
    input.name,
    input.kind,
    now,
    now,
  );
  return requireLocation(db, lastId);
}

export interface LocationPatch {
  code?: string;
  name?: string;
  kind?: LocationKind;
}

export async function updateLocation(
  db: Db,
  id: number,
  patch: LocationPatch,
): Promise<LocationWithStock> {
  await requireLocation(db, id);

  const assignments: string[] = [];
  const params: SqlValue[] = [];
  for (const key of ['code', 'name', 'kind'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${key} = ?`);
    params.push(value);
  }

  if (assignments.length === 0) throw new HttpError(400, 'No fields to update');

  assignments.push('updated_at = ?');
  params.push(new Date().toISOString(), id);

  await run(db, `UPDATE locations SET ${assignments.join(', ')} WHERE id = ?`, ...params);
  return requireLocation(db, id);
}

export async function countMovementsForLocation(db: Db, id: number): Promise<number> {
  const row = await one<{ total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM movements WHERE location_id = ?',
    id,
  );
  return row?.total ?? 0;
}

/** Location and ledger together, for the same reason as deleteItem. */
export async function deleteLocation(db: Db, id: number): Promise<number> {
  const [movements, locations] = await batch(db, [
    statement(db, 'DELETE FROM movements WHERE location_id = ?', id),
    statement(db, 'DELETE FROM locations WHERE id = ?', id),
  ]);

  if ((locations?.changes ?? 0) === 0) throw new HttpError(404, `No location with id ${id}`);
  return movements?.changes ?? 0;
}
