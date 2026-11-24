import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { ZodError } from 'zod';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { AppError } from '../utils/errors.js';
import teamsRouter from './routes/teams.js';
import playersRouter from './routes/players.js';
import matchesRouter from './routes/matches.js';
import resultsRouter from './routes/results.js';
import exportRouter from './routes/export.js';
import prisma from '../database/prisma.js';

export function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin: config.api.corsOrigin === '*' ? '*' : config.api.corsOrigin.split(','),
    }),
  );
  app.use(express.json({ limit: config.maxFileSize }));

  app.get('/health', async (req, res) => {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'unavailable';
    }
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', apiLimiter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/players', playersRouter);
  app.use('/api/matches', matchesRouter);
  app.use('/api/results', resultsRouter);
  app.use('/api/export', exportRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(422).json({ error: 'Validation error', details: err.flatten() });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    }
    logger.error({ err }, 'Unhandled API error');
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export default buildApp;
