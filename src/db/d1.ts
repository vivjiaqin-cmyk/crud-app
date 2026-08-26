/**
 * Thin helpers over the D1 binding: bind, run, and give back plain rows.
 *
 * The one structural difference from a local SQLite handle is transactions. D1
 * has no interactive BEGIN/COMMIT — a request cannot hold a transaction open
 * across awaits — so multi-statement writes go through `batch()`, which runs its
 * statements in order inside a single implicit transaction. Where a check has to
 * be atomic with the write it guards, the check moves *into* the statement (see
 * the guarded inserts in data/movements.ts) rather than being read separately.
 */

export type Db = D1Database;
export type SqlValue = string | number | null;

function prepare(db: Db, sql: string, params: SqlValue[]): D1PreparedStatement {
  const statement = db.prepare(sql);
  return params.length > 0 ? statement.bind(...params) : statement;
}

export async function all<T>(db: Db, sql: string, ...params: SqlValue[]): Promise<T[]> {
  const { results } = await prepare(db, sql, params).all<T>();
  return results;
}

export async function one<T>(db: Db, sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  const row = await prepare(db, sql, params).first<T>();
  return row ?? undefined;
}

export interface WriteResult {
  changes: number;
  lastId: number;
}

export async function run(db: Db, sql: string, ...params: SqlValue[]): Promise<WriteResult> {
  return toWriteResult(await prepare(db, sql, params).run());
}

export function statement(db: Db, sql: string, ...params: SqlValue[]): D1PreparedStatement {
  return prepare(db, sql, params);
}

/** All of them, in order, in one transaction: either every row lands or none does. */
export async function batch(db: Db, statements: D1PreparedStatement[]): Promise<WriteResult[]> {
  const results = await db.batch(statements);
  return results.map(toWriteResult);
}

function toWriteResult(result: { meta: D1Meta }): WriteResult {
  return {
    changes: result.meta.changes ?? 0,
    lastId: Number(result.meta.last_row_id ?? 0),
  };
}
