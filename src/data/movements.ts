import { all, batch, one, run, statement, type Db, type SqlValue } from '../db/d1';
import { HttpError } from '../errors';
import type { Movement, MovementDetail, MovementKind } from '../types';

/**
 * The ledger. Nothing here updates a stored quantity, because there is no stored
 * quantity: writing a movement *is* changing the stock level, and every balance
 * in the app is a SUM over these rows.
 *
 * Kinds callers may post directly. transfer_in and transfer_out exist only as a
 * pair, written by transferStock, so a transfer can never lose half of itself.
 */
export const POSTABLE_KINDS = ['receipt', 'issue', 'adjustment'] as const;
export type PostableKind = (typeof POSTABLE_KINDS)[number];

export const MOVEMENT_KINDS = [
  'receipt',
  'issue',
  'adjustment',
  'transfer_in',
  'transfer_out',
] as const;

interface MovementRow {
  id: number;
  item_id: number;
  location_id: number;
  kind: string;
  quantity: number;
  reference: string | null;
  note: string | null;
  transfer_group: string | null;
  occurred_at: string;
  created_at: string;
}

interface MovementDetailRow extends MovementRow {
  sku: string;
  item_name: string;
  location_code: string;
  location_name: string;
}

const SELECT_DETAIL = `
  SELECT m.*,
         i.sku  AS sku,
         i.name AS item_name,
         l.code AS location_code,
         l.name AS location_name
  FROM movements m
  JOIN items i     ON i.id = m.item_id
  JOIN locations l ON l.id = m.location_id
`;

function toMovement(row: MovementRow): Movement {
  return {
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id,
    kind: row.kind as MovementKind,
    quantity: row.quantity,
    reference: row.reference,
    note: row.note,
    transferGroup: row.transfer_group,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function toDetail(row: MovementDetailRow): MovementDetail {
  return {
    ...toMovement(row),
    sku: row.sku,
    itemName: row.item_name,
    locationCode: row.location_code,
    locationName: row.location_name,
  };
}

export interface MovementFilters {
  itemId?: number;
  locationId?: number;
  kind?: MovementKind;
  /** Inclusive ISO date or timestamp bounds on occurred_at. */
  from?: string;
  to?: string;
  offset: number;
  limit: number;
}

function whereFor(filters: MovementFilters): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (filters.itemId !== undefined) {
    clauses.push('m.item_id = ?');
    params.push(filters.itemId);
  }
  if (filters.locationId !== undefined) {
    clauses.push('m.location_id = ?');
    params.push(filters.locationId);
  }
  if (filters.kind !== undefined) {
    clauses.push('m.kind = ?');
    params.push(filters.kind);
  }
  if (filters.from !== undefined) {
    clauses.push('m.occurred_at >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    clauses.push('m.occurred_at <= ?');
    params.push(filters.to);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function listMovements(
  db: Db,
  filters: MovementFilters,
): Promise<{ total: number; movements: MovementDetail[] }> {
  const where = whereFor(filters);

  const [totals, page] = await db.batch<Record<string, unknown>>([
    statement(db, `SELECT COUNT(*) AS total FROM movements m ${where.sql}`, ...where.params),
    statement(
      db,
      `${SELECT_DETAIL} ${where.sql} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      ...where.params,
      filters.limit,
      filters.offset,
    ),
  ]);

  const total = Number((totals?.results[0] as { total?: number } | undefined)?.total ?? 0);
  const rows = (page?.results ?? []) as unknown as MovementDetailRow[];

  return { total, movements: rows.map(toDetail) };
}

export async function findMovement(db: Db, id: number): Promise<MovementDetail | undefined> {
  const row = await one<MovementDetailRow>(db, `${SELECT_DETAIL} WHERE m.id = ?`, id);
  return row === undefined ? undefined : toDetail(row);
}

export async function requireMovement(db: Db, id: number): Promise<MovementDetail> {
  const movement = await findMovement(db, id);
  if (movement === undefined) throw new HttpError(404, `No movement with id ${id}`);
  return movement;
}

/** On-hand for one item at one location, straight from the ledger. */
export async function onHandAt(db: Db, itemId: number, locationId: number): Promise<number> {
  const row = await one<{ on_hand: number | null }>(
    db,
    'SELECT SUM(quantity) AS on_hand FROM movements WHERE item_id = ? AND location_id = ?',
    itemId,
    locationId,
  );
  return row?.on_hand ?? 0;
}

/**
 * The insert that enforces the no-negative-stock rule.
 *
 * The balance check is part of the statement, not a read before it: D1 has no
 * interactive transaction to hold across an await, so a separate SELECT then
 * INSERT would leave a window where two concurrent issues both see enough stock.
 * As one statement, SQLite evaluates the sum and the insert together — zero rows
 * affected means the guard refused it.
 */
const GUARDED_INSERT = `
  INSERT INTO movements
    (item_id, location_id, kind, quantity, reference, note, transfer_group, occurred_at, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE ? = 1
     OR ? >= 0
     OR (SELECT COALESCE(SUM(quantity), 0) FROM movements WHERE item_id = ? AND location_id = ?) + ? >= 0
`;

function guardedInsertParams(
  itemId: number,
  locationId: number,
  kind: MovementKind,
  delta: number,
  reference: string | null,
  note: string | null,
  group: string | null,
  occurredAt: string,
  createdAt: string,
  allowNegativeStock: boolean,
): SqlValue[] {
  return [
    itemId,
    locationId,
    kind,
    delta,
    reference,
    note,
    group,
    occurredAt,
    createdAt,
    allowNegativeStock ? 1 : 0,
    delta,
    itemId,
    locationId,
    delta,
  ];
}

/** The 409 the guard implies, with the balance that caused it. */
async function insufficient(
  db: Db,
  itemId: number,
  locationId: number,
  wanted: number,
): Promise<HttpError> {
  const current = await onHandAt(db, itemId, locationId);
  return new HttpError(
    409,
    `Only ${current} on hand at this location; cannot remove ${Math.abs(wanted)}`,
  );
}

export interface NewMovement {
  itemId: number;
  locationId: number;
  kind: PostableKind;
  /** Magnitude for receipt and issue; a signed delta for adjustment. */
  quantity: number;
  reference: string | null;
  note: string | null;
  occurredAt: string;
  allowNegativeStock: boolean;
}

/** Applies the sign that goes with the kind, so callers never pass -5 for an issue. */
function signedQuantity(kind: PostableKind, quantity: number): number {
  if (kind === 'adjustment') {
    if (quantity === 0) throw new HttpError(400, 'quantity must not be zero');
    return quantity;
  }
  if (quantity <= 0) {
    throw new HttpError(400, `quantity must be a positive number for a ${kind}`);
  }
  return kind === 'issue' ? -quantity : quantity;
}

export async function createMovement(db: Db, input: NewMovement): Promise<MovementDetail> {
  const delta = signedQuantity(input.kind, input.quantity);

  const { changes, lastId } = await run(
    db,
    GUARDED_INSERT,
    ...guardedInsertParams(
      input.itemId,
      input.locationId,
      input.kind,
      delta,
      input.reference,
      input.note,
      null,
      input.occurredAt,
      new Date().toISOString(),
      input.allowNegativeStock,
    ),
  );

  if (changes === 0) throw await insufficient(db, input.itemId, input.locationId, delta);
  return requireMovement(db, lastId);
}

export interface NewTransfer {
  itemId: number;
  fromLocationId: number;
  toLocationId: number;
  /** Always positive: the direction is carried by the two location ids. */
  quantity: number;
  reference: string | null;
  note: string | null;
  occurredAt: string;
  allowNegativeStock: boolean;
}

/**
 * Moves stock between locations as two rows sharing a transfer_group, in one
 * batch — a single transaction, statements in order. The outbound half carries
 * the balance guard; the inbound half only inserts if the outbound one landed,
 * so a refused transfer writes nothing and the total across locations cannot
 * change.
 */
const PAIRED_INSERT = `
  INSERT INTO movements
    (item_id, location_id, kind, quantity, reference, note, transfer_group, occurred_at, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE (SELECT COUNT(*) FROM movements WHERE transfer_group = ?) = 1
`;

export async function transferStock(
  db: Db,
  input: NewTransfer,
): Promise<{ group: string; out: MovementDetail; in: MovementDetail }> {
  if (input.quantity <= 0) throw new HttpError(400, 'quantity must be a positive number');
  if (input.fromLocationId === input.toLocationId) {
    throw new HttpError(400, 'fromLocationId and toLocationId must differ');
  }

  const group = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const [outbound, inbound] = await batch(db, [
    statement(
      db,
      GUARDED_INSERT,
      ...guardedInsertParams(
        input.itemId,
        input.fromLocationId,
        'transfer_out',
        -input.quantity,
        input.reference,
        input.note,
        group,
        input.occurredAt,
        now,
        input.allowNegativeStock,
      ),
    ),
    statement(
      db,
      PAIRED_INSERT,
      input.itemId,
      input.toLocationId,
      'transfer_in',
      input.quantity,
      input.reference,
      input.note,
      group,
      input.occurredAt,
      now,
      group,
    ),
  ]);

  if (outbound === undefined || outbound.changes === 0) {
    throw await insufficient(db, input.itemId, input.fromLocationId, -input.quantity);
  }

  if (inbound === undefined || inbound.changes === 0) {
    // Unreachable while the paired guard holds, but a half transfer is the one
    // state this table must never be left in — undo the outbound row and say so.
    await run(db, 'DELETE FROM movements WHERE transfer_group = ?', group);
    throw new HttpError(500, 'Transfer could not be completed; nothing was recorded');
  }

  return {
    group,
    out: await requireMovement(db, outbound.lastId),
    in: await requireMovement(db, inbound.lastId),
  };
}

/**
 * Removes a movement, and both halves when it belongs to a transfer — deleting
 * one half alone would invent or destroy stock. Refuses when the removal would
 * drive a balance negative, for the same reason an over-issue is refused.
 *
 * The balances are checked before the deletes rather than inside them: a partly
 * applied delete would break a transfer pair, which is worse than the narrow
 * race this leaves against a concurrent write to the same item and location.
 */
export async function deleteMovement(
  db: Db,
  id: number,
  allowNegativeStock: boolean,
): Promise<number> {
  const movement = await requireMovement(db, id);
  const group = movement.transferGroup;

  const doomed: Movement[] =
    group === null
      ? [movement]
      : (await all<MovementRow>(db, 'SELECT * FROM movements WHERE transfer_group = ?', group)).map(
          toMovement,
        );

  if (!allowNegativeStock) {
    for (const row of doomed) {
      // Undoing an inbound row removes stock; check the balance can take it.
      if (row.quantity <= 0) continue;
      const current = await onHandAt(db, row.itemId, row.locationId);
      if (current - row.quantity < 0) {
        throw new HttpError(
          409,
          `Deleting movement ${row.id} would leave a negative balance; reverse it with an adjustment instead`,
        );
      }
    }
  }

  const results = await batch(
    db,
    doomed.map((row) => statement(db, 'DELETE FROM movements WHERE id = ?', row.id)),
  );

  return results.reduce((total, result) => total + result.changes, 0);
}
