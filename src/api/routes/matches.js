import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import prisma from '../../database/prisma.js';
import * as matchService from '../../services/matchService.js';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  status: z.string().trim().optional(),
  teamId: z.string().trim().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, status, teamId } = listQuery.parse(req.query);
    const where = {};
    if (status) where.status = status;
    if (teamId) where.OR = [{ team1_id: teamId }, { team2_id: teamId }];
    const [data, total] = await Promise.all([
      prisma.matches.findMany({
        where,
        include: { team1: true, team2: true, results: true },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.matches.count({ where }),
    ]);
    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const match = await matchService.getMatch(req.params.id);
    res.json(match);
  }),
);

export default router;
