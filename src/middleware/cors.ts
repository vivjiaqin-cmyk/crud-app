import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * This API writes, so the default "*" is only safe because it carries no
 * credentials: there is no session or cookie for another origin to ride on. Put
 * it behind auth before exposing it beyond a trusted network, and narrow
 * CORS_ORIGINS to the pages that should reach it.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const allowed = config.corsOrigins;
  const origin = req.headers.origin;

  if (allowed.length === 1 && allowed[0] === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin !== undefined && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Caches must not serve one origin's response to another.
    res.setHeader('Vary', 'Origin');
  } else if (origin !== undefined) {
    // Not allowed: send no CORS header at all and let the browser refuse.
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
