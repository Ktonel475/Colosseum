import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as teamService from '../../services/teamService.js';
import prisma from '../../database/prisma.js';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, search, includeInactive } = listQuery.parse(req.query);
    const where = {};
    if (includeInactive !== 'true') where.is_active = true;
    if (search) where.team_name = { contains: search };
    const [data, total] = await Promise.all([
      prisma.teams.findMany({
        where,
        orderBy: { team_name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.teams.count({ where }),
    ]);
    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const team = await teamService.getTeam(req.params.id);
    res.json(team);
  }),
);

export default router;
