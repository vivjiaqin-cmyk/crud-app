import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { cors } from './middleware/cors.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';
import { itemsRouter } from './routes/items.js';
import { locationsRouter } from './routes/locations.js';
import { movementsRouter } from './routes/movements.js';
import { stockRouter } from './routes/stock.js';

/** Resolved from this file so it works from src/ under tsx and from dist/ built. */
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api', (_req, res) => {
    res.json({
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
    });
  });

  app.use(healthRouter);
  app.use(itemsRouter);
  app.use(locationsRouter);
  app.use(movementsRouter);
  app.use(stockRouter);

  // The browser UI. Served last so a page can never shadow an API route.
  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
