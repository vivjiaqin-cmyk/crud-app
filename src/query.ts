import { HttpError } from './middleware/errors.js';

/**
 * Express gives `string | string[] | ParsedQs | undefined` for every query value.
 * These narrow it to what a handler actually wants, rejecting the rest with a 400
 * that says which parameter was wrong rather than failing deeper in.
 */

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a single value`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function intParam(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = optionalString(value, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** An id in the path, e.g. /items/12. */
export function idParam(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return parsed;
}

/** Optional id filter from the query string, e.g. ?item=12. */
export function optionalIdParam(value: unknown, name: string): number | undefined {
  const raw = optionalString(value, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return parsed;
}

/** ?flag, ?flag=true and ?flag=1 all mean true. */
export function boolParam(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a single value`);
  const raw = value.trim().toLowerCase();
  if (raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new HttpError(400, `${name} must be true or false`);
}

export function enumParam<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = optionalString(value, name);
  if (raw === undefined) return undefined;
  // Case-insensitive both ways, so ?sort=onhand matches the camelCase option.
  const match = allowed.find((option) => option.toLowerCase() === raw.toLowerCase());
  if (match === undefined) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
  return match;
}
