import { resolve } from 'node:path';

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (items.length === 0) throw new Error(`${name} must list at least one origin`);
  return items;
}

export const config = {
  port: intFromEnv('PORT', 3100, 1, 65535),
  env: process.env['NODE_ENV'] ?? 'development',

  /**
   * SQLite file. ":memory:" gives a throwaway database, which is what the tests
   * and a quick demo want.
   */
  dbFile: process.env['DB_FILE'] ?? resolve('data/inventory.db'),

  /**
   * Off by default: an issue that would drive on-hand below zero is a data entry
   * mistake far more often than it is a real backorder. Turn it on if your
   * process genuinely books issues before receipts land.
   */
  allowNegativeStock: boolFromEnv('ALLOW_NEGATIVE_STOCK', false),

  /** Origins allowed to call this API from a browser; "*" for any. */
  corsOrigins: listFromEnv('CORS_ORIGINS', ['*']),
} as const;
