import { SELF, env } from 'cloudflare:test';
import app from '../src/index';

/**
 * Shared test plumbing.
 *
 * `request` goes through SELF, so a test exercises the deployed path: the body
 * limit, the CORS middleware, the router and the error handler, in that order.
 * `requestWith` calls the app directly with a synthesised env, which is the only
 * way to test behaviour that depends on a binding value (CORS_ORIGINS,
 * ALLOW_NEGATIVE_STOCK) without redeploying.
 */

const ORIGIN = 'https://inventory.test';

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

async function toReply<T>(response: Response): Promise<Reply<T>> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies (a plain-text error page) are returned as-is.
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

export interface Options {
  method?: string;
  /** Serialised as JSON; use `raw` to send something that is not. */
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

function toRequest(path: string, options: Options = {}): Request {
  const hasBody = options.body !== undefined || options.raw !== undefined;
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(hasBody ? { body: options.raw ?? JSON.stringify(options.body) } : {}),
  });
}

export function request<T = any>(path: string, options: Options = {}): Promise<Reply<T>> {
  return SELF.fetch(toRequest(path, options)).then(toReply<T>);
}

/** The same request, but with these vars overriding the configured bindings. */
export function requestWith<T = any>(
  vars: Record<string, string>,
  path: string,
  options: Options = {},
): Promise<Reply<T>> {
  return app.fetch(toRequest(path, options), { ...env, ...vars } as never).then(toReply<T>);
}

export interface Fixtures {
  warehouse: number;
  store: number;
  bolts: number;
  cable: number;
  spare: number;
}

/**
 * Two locations and three items, inserted directly rather than through the API
 * so a route's own bugs cannot quietly shape the fixture the test then asserts
 * against. Ids are fixed, which keeps the expectations readable.
 *
 * No movements: stock is a separate act in this model, and most tests want to
 * control exactly what the ledger contains.
 */
export async function fixtures(): Promise<Fixtures> {
  const now = new Date().toISOString();

  await env.DB.batch([
    // Storage is isolated per test *file*, not per test, so each fixture starts
    // by clearing what the previous test left behind.
    env.DB.prepare('DELETE FROM movements'),
    env.DB.prepare('DELETE FROM items'),
    env.DB.prepare('DELETE FROM locations'),
    env.DB.prepare(
      'INSERT INTO locations (id, code, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(1, 'WH-A', 'Main Warehouse', 'warehouse', now, now),
    env.DB.prepare(
      'INSERT INTO locations (id, code, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(2, 'ST-1', 'Shopfront', 'store', now, now),
    env.DB.prepare(
      `INSERT INTO items (id, sku, name, description, category, unit, unit_cost_cents, reorder_point, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(1, 'BLT-M6', 'Hex bolt M6', 'Zinc plated', 'Fasteners', 'box of 100', 480, 10, now, now),
    env.DB.prepare(
      `INSERT INTO items (id, sku, name, description, category, unit, unit_cost_cents, reorder_point, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(2, 'CBL-CAT6', 'Cat6 patch cable', null, 'Cabling', 'each', 190, 4, now, now),
    env.DB.prepare(
      `INSERT INTO items (id, sku, name, description, category, unit, unit_cost_cents, reorder_point, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(3, 'SPR-50%', 'Spare 50% blend', 'Has a literal percent sign', null, 'each', 0, 0, now, now),
  ]);

  return { warehouse: 1, store: 2, bolts: 1, cable: 2, spare: 3 };
}

/** Posts a movement through the API, failing loudly if the API refused it. */
export async function move(body: Record<string, unknown>): Promise<Reply> {
  const reply = await request('/movements', { method: 'POST', body });
  if (reply.status !== 201) {
    throw new Error(`fixture movement rejected: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  return reply;
}

export async function countMovements(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM movements').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}
