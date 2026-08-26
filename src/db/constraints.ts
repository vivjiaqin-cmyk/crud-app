import { HttpError } from '../errors';

/**
 * Turns SQLite constraint failures into the 4xx they really are.
 *
 * The routes check for a duplicate SKU or code before inserting, which catches
 * the ordinary case with a clear message. On Workers that check and the insert
 * are separate round trips to D1, so two requests racing on the same SKU can
 * both pass it — the UNIQUE index is what actually holds the line, and this
 * keeps that path from surfacing as an opaque 500.
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
export async function guard<T>(
  context: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asHttpError(err, context);
  }
}
