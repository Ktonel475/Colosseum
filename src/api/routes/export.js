import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireApiKey } from '../middleware/auth.js';
import * as exportService from '../../services/exportService.js';

const router = Router();

const formatQuery = z.object({
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});

const DATASETS = ['teams', 'players', 'matches', 'results'];

function send(res, result) {
  res.setHeader('Content-Type', result.contentType);
  if (result.filename.endsWith('.xlsx') || result.filename.endsWith('.csv') || result.filename.endsWith('.json')) {
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  }
  res.send(result.body);
}

for (const dataset of DATASETS) {
  router.get(
    `/${dataset}`,
    requireApiKey,
    asyncHandler(async (req, res) => {
      const { format } = formatQuery.parse(req.query);
      const result = await exportService.exportDataset(dataset, format);
      send(res, result);
    }),
  );
}

router.get(
  '/all',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { format } = formatQuery.parse(req.query);
    const result = await exportService.exportAll(format);
    send(res, result);
  }),
);

export default router;
