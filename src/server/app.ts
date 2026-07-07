// app.ts — express app assembly: JSON parsing, routes, static frontend,
// contract-shaped errors.
// Why separate from index.ts: tests build the app (plus server + ws) against
// a test database without touching process.env or real ports.

import { join } from 'node:path';
import express from 'express';
import type pg from 'pg';
import type { Explainer } from '../ai/explainer.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { Exchange } from './exchange.js';
import { buildRoutes } from './routes.js';
import type { WriteBehind } from '../db/write-behind.js';

export function buildApp(exchange: Exchange, pool: pg.Pool, wb: WriteBehind, config: Config, explainer: Explainer): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.use('/api', buildRoutes(exchange, pool, wb, config, explainer));

  // The frontend (web/): a static single-page terminal served from the same
  // origin, so its relative /api and /ws URLs need no configuration. Resolved
  // from the project root like schema.sql (db.ts) — works compiled and in dev.
  app.use(express.static(join(process.cwd(), 'web')));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  });

  // Contract error shape for everything thrown below routes.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'malformed JSON body' } });
      return;
    }
    console.error('unhandled error', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  return app;
}
