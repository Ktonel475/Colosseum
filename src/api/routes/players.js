import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import prisma from '../../database/prisma.js';
import { NotFoundError } from '../../utils/errors.js';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().optional(),
  teamId: z.string().trim().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, search, teamId } = listQuery.parse(req.query);
    const where = {};
    if (teamId) where.team_id = teamId;
    if (search) where.discord_username = { contains: search };
    const [data, total] = await Promise.all([
      prisma.players.findMany({
        where,
        include: { team: { select: { team_id: true, team_name: true, is_active: true } } },
        orderBy: { discord_username: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.players.count({ where }),
    ]);
    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }),
);

router.get(
  '/:discordId',
  asyncHandler(async (req, res) => {
    const player = await prisma.players.findUnique({
      where: { discord_user_id: req.params.discordId },
      include: { team: true },
    });
    if (!player) throw new NotFoundError('Player not found');
    res.json(player);
  }),
);

export default router;
