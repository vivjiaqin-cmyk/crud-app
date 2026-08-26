import { HttpError } from './errors';

/**
 * Body validation for the write endpoints. Every helper names the field it
 * rejected, because "reorderPoint must be an integer between 0 and 1000000" is
 * the only kind of error message a client can act on.
 *
 * Absent fields come back as ABSENT rather than undefined, so a PATCH can tell
 * "leave this alone" apart from "set this to null".
 */

export const ABSENT = Symbol('absent');

/** Reads and validates the request body, in the shape every write route wants. */
export async function jsonBody(request: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
  return asObject(parsed);
}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Rejects unexpected keys, so a typo like "reorderpoint" is not silently dropped. */
export function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new HttpError(
      400,
      `Unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}`,
    );
  }
}

export function requiredString(
  body: Record<string, unknown>,
  name: string,
  maxLength = 200,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${name} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  name: string,
  maxLength = 200,
): string | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  return requiredString(body, name, maxLength);
}

/** A string that may be omitted, cleared with null or an empty string, or set. */
export function nullableString(
  body: Record<string, unknown>,
  name: string,
  maxLength = 2000,
): string | null | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function integer(
  body: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  const value = body[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Money, taken in currency units and returned as integer cents. Two decimals is
 * the limit: a third of a cent would only round away somewhere later anyway.
 */
export function money(
  body: Record<string, unknown>,
  name: string,
  max = 10_000_000,
): number | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  const value = body[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new HttpError(400, `${name} must be a number between 0 and ${max}`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new HttpError(400, `${name} must have at most 2 decimal places`);
  }
  return cents;
}

export function boolean(body: Record<string, unknown>, name: string): boolean | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  const value = body[name];
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false`);
  return value;
}

export function enumField<T extends string>(
  body: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | typeof ABSENT {
  if (!(name in body)) return ABSENT;
  const value = body[name];
  if (typeof value !== 'string') {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
  const needle = value.trim().toLowerCase();
  const match = allowed.find((option) => option.toLowerCase() === needle);
  if (match === undefined) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  }
  return match;
}

/** An ISO timestamp, defaulting to now. Rejects unparseable and future dates. */
export function timestamp(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (value === undefined || value === null) return new Date().toISOString();
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${name} must be an ISO timestamp, got "${value}"`);
  }
  // A day of slack covers clock skew and timezone mistakes; a week does not.
  if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new HttpError(400, `${name} cannot be more than a day in the future`);
  }
  return parsed.toISOString();
}
