import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
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
 * Bodies are capped before anything parses them. Without this an oversized
 * request is read in full and then rejected by a field-length check, which
 * charges the caller's mistake to the Worker — and reports it as a 400 about one
 * field rather than as the size problem it is.
 */
app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large (limit 64kb)' }, 413),
  }),
);

/**
 * CORS is off unless configured, and that is the security boundary here rather
 * than a nicety: this API has no authentication, so reaching an endpoint *is*
 * the authorisation. A cross-origin write is not a simple request — the browser
 * preflights it — which means the absence of Access-Control-Allow-Origin is what
 * stops any page the operator visits from posting movements or deleting a
 * ledger. The bundled UI is served from this same origin and calls relative
 * paths, so it needs no CORS headers and loses nothing.
 *
 * Set CORS_ORIGINS to a comma-separated list, or "*", to opt in.
 */
app.use('*', (c, next) => {
  const { corsOrigins } = settings(c.env);
  if (corsOrigins.length === 0) return next();

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

  // Anything the framework raised already knows its own status; a client mistake
  // must not be logged as a server fault or reported as a 500.
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || 'Request rejected' }, err.status);
  }

  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
