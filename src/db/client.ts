import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrate } from './schema.js';

/**
 * One synchronous SQLite handle for the process. node:sqlite blocks the event
 * loop for the duration of a statement, which is the right trade at this size:
 * every query here is indexed and single-digit-millisecond, and in exchange the
 * data layer needs no connection pool, no async plumbing, and no dependency.
 */

let handle: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (handle === undefined) handle = open(config.dbFile);
  return handle;
}

function open(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const database = new DatabaseSync(file);

  // Foreign keys are off by default in SQLite; without this the ON DELETE rules
  // in the schema would be decoration.
  database.exec('PRAGMA foreign_keys = ON');
  // WAL survives a hard stop mid-write and lets readers run during a write.
  if (file !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');

  migrate(database);
  return database;
}

export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

/**
 * Runs fn inside a transaction, rolling back if it throws. Used wherever one
 * request writes more than one row — a transfer, or deleting an item along with
 * its ledger — so a failure halfway cannot leave stock invented or lost.
 */
export function transaction<T>(fn: () => T): T {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

/** node:sqlite hands back null-prototype rows; these cast them to a row type. */
export function all<T>(sql: string, ...params: SqlValue[]): T[] {
  return db().prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(sql: string, ...params: SqlValue[]): T | undefined {
  return db().prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, ...params: SqlValue[]): { changes: number; lastId: number } {
  const result = db().prepare(sql).run(...params);
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

export type SqlValue = string | number | null;
