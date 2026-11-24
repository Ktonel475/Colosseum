import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import prisma from '../../database/prisma.js';
import * as resultService from '../../services/resultService.js';
import { NotFoundError } from '../../utils/errors.js';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  status: z.string().trim().optional(),
  matchId: z.string().trim().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, status, matchId } = listQuery.parse(req.query);
    const where = {};
    if (status) where.status = status;
    if (matchId) where.match_id = matchId;
    const [data, total] = await Promise.all([
      prisma.results.findMany({
        where,
        include: {
          match: { include: { team1: true, team2: true } },
          confirmations: true,
        },
        orderBy: { submitted_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.results.count({ where }),
    ]);
    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }),
);

router.get(
  '/:matchId',
  asyncHandler(async (req, res) => {
    const result = await resultService.getResultByMatch(req.params.matchId);
    if (!result) throw new NotFoundError('No result for this match');
    res.json(result);
  }),
);

export default router;
