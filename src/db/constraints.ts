import { HttpError } from '../middleware/errors.js';

/**
 * Turns SQLite constraint failures into the 4xx they really are.
 *
 * The routes check for a duplicate SKU or code before inserting, and because
 * node:sqlite is synchronous that check cannot be interleaved with another
 * request in this process. A second process writing the same file still can
 * collide, and the UNIQUE index is what actually holds the line — this keeps
 * that path from surfacing as an opaque 500.
 */
export function asHttpError(err: unknown, context: Record<string, string>): unknown {
  if (!(err instanceof Error)) return err;

  if (err.message.includes('UNIQUE constraint failed')) {
    for (const [column, message] of Object.entries(context)) {
      if (err.message.includes(column)) return new HttpError(409, message);
    }
    return new HttpError(409, 'That value is already taken');
  }

  if (err.message.includes('FOREIGN KEY constraint failed')) {
    return new HttpError(400, 'Referenced item or location does not exist');
  }

  if (err.message.includes('CHECK constraint failed')) {
    return new HttpError(400, 'Values violate a database constraint');
  }

  return err;
}

/** Runs fn, rewriting constraint failures on the way out. */
export function guard<T>(context: Record<string, string>, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw asHttpError(err, context);
  }
}
