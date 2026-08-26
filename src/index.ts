import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { settings, type AppEnv } from './env';
import { HttpError } from './errors';
import { health } from './routes/health';
import { items } from './routes/items';
import { locations } from './routes/locations';
import { movements } from './routes/movements';
import { stock } from './routes/stock';

/**
 * The Worker. Static assets are matched before this runs — GET / serves the UI
 * straight from Cloudflare's edge — so everything arriving here is an API call
 * or a path that matches nothing.
 */
const app = new Hono<AppEnv>();

/**
 * This API writes, so the default "*" is only safe because it carries no
 * credentials: there is no session or cookie for another origin to ride on. Put
 * it behind auth before exposing it beyond a trusted network, and narrow
 * CORS_ORIGINS to the pages that should reach it.
 */
app.use('*', (c, next) => {
  const { corsOrigins } = settings(c.env);
  const wildcard = corsOrigins.length === 1 && corsOrigins[0] === '*';

  return cors({
    origin: wildcard ? '*' : corsOrigins,
    allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  })(c, next);
});

app.get('/api', (c) =>
  c.json({
    name: 'crud-app',
    description: 'Inventory tracking: items, locations, and a stock movement ledger.',
    endpoints: [
      'GET    /health',
      'GET    /items?q=&category=&lowStock&archived&sort=&offset=&limit=',
      'POST   /items',
      'GET    /items/categories',
      'GET    /items/:id',
      'PATCH  /items/:id',
      'DELETE /items/:id?force=true',
      'GET    /items/:id/stock',
      'GET    /locations?kind=',
      'POST   /locations',
      'GET    /locations/:id',
      'PATCH  /locations/:id',
      'DELETE /locations/:id?force=true',
      'GET    /movements?item=&location=&kind=&from=&to=&offset=&limit=',
      'POST   /movements',
      'GET    /movements/:id',
      'DELETE /movements/:id',
      'POST   /transfers',
      'GET    /stock?item=&location=&includeZero',
      'GET    /stock/low?limit=',
      'GET    /stock/summary',
    ],
    notes: [
      'Stock is never stored, only summed from /movements.',
      'quantity is a positive magnitude for receipt and issue; signed for adjustment.',
    ],
  }),
);

app.route('/', health);
app.route('/', items);
app.route('/', locations);
app.route('/', movements);
app.route('/', stock);

app.notFound((c) =>
  c.json({ error: `No handler for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404),
);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  }

  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
