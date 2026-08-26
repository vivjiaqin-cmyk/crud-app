import type { DatabaseSync } from 'node:sqlite';

/**
 * The schema, applied on every start. Each statement is idempotent, so this is
 * both the initial create and the no-op on an existing file.
 *
 * Two rules are worth reading before the DDL:
 *
 * 1. Stock is never stored. `items` has no quantity column; on-hand is always
 *    SUM(movements.quantity). A stored counter and a ledger drift apart the
 *    first time a write half-fails, and then nobody can say which is right.
 *
 * 2. The sign of a movement is fixed by its kind, in a CHECK constraint rather
 *    than in application code. A receipt that removes stock is not a bug to be
 *    found later; it is a row the database refuses.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id              INTEGER PRIMARY KEY,
      sku             TEXT    NOT NULL,
      name            TEXT    NOT NULL,
      description     TEXT,
      category        TEXT,
      unit            TEXT    NOT NULL DEFAULT 'each',
      unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
      reorder_point   INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
      archived        INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    );

    -- NOCASE so "wid-001" cannot be entered alongside "WID-001".
    CREATE UNIQUE INDEX IF NOT EXISTS items_sku_unique ON items (sku COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS items_category ON items (category);

    CREATE TABLE IF NOT EXISTS locations (
      id         INTEGER PRIMARY KEY,
      code       TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      kind       TEXT    NOT NULL DEFAULT 'warehouse'
                 CHECK (kind IN ('warehouse', 'store', 'transit')),
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS locations_code_unique ON locations (code COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS movements (
      id             INTEGER PRIMARY KEY,
      item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      location_id    INTEGER NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
      kind           TEXT    NOT NULL
                     CHECK (kind IN ('receipt', 'issue', 'adjustment', 'transfer_in', 'transfer_out')),
      quantity       INTEGER NOT NULL,
      reference      TEXT,
      note           TEXT,
      transfer_group TEXT,
      occurred_at    TEXT    NOT NULL,
      created_at     TEXT    NOT NULL,

      -- Inbound kinds add, outbound kinds remove, adjustments go either way but
      -- never nowhere: a zero-quantity movement is a record of nothing.
      CHECK (
        (kind IN ('receipt', 'transfer_in')   AND quantity > 0) OR
        (kind IN ('issue', 'transfer_out')    AND quantity < 0) OR
        (kind = 'adjustment'                  AND quantity <> 0)
      )
    );

    CREATE INDEX IF NOT EXISTS movements_item     ON movements (item_id, location_id);
    CREATE INDEX IF NOT EXISTS movements_location ON movements (location_id);
    CREATE INDEX IF NOT EXISTS movements_recent   ON movements (occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS movements_transfer ON movements (transfer_group);

    -- On-hand per item per location. Rows only exist where stock has moved, so
    -- callers that need every pair join from items and locations instead.
    CREATE VIEW IF NOT EXISTS stock_levels AS
      SELECT item_id, location_id, SUM(quantity) AS on_hand
      FROM movements
      GROUP BY item_id, location_id;
  `);
}
