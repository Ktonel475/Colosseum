import prisma from '../../../database/prisma.js';

function parseResult(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toDomain(row) {
  return {
    id: row.id,
    roundChannelId: row.round_channel_id,
    threadId: row.thread_id,
    team1Id: row.team1_id,
    team2Id: row.team2_id,
    status: row.status,
    result: parseResult(row.result),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Prisma implementation of the match repository contract. The module only
 * depends on this interface, so swapping it for another database means writing
 * one class and passing it to the services.
 */
export class PrismaMatchRepository {
  constructor(client = prisma) {
    this.prisma = client;
  }

  async create({ roundChannelId, threadId, team1Id, team2Id }) {
    const row = await this.prisma.match_module_records.create({
      data: {
        round_channel_id: roundChannelId,
        thread_id: threadId,
        team1_id: team1Id,
        team2_id: team2Id,
      },
    });
    return toDomain(row);
  }

  async findByThreadId(threadId) {
    const row = await this.prisma.match_module_records.findUnique({
      where: { thread_id: threadId },
    });
    return row ? toDomain(row) : null;
  }

  async listByRound(roundChannelId) {
    const rows = await this.prisma.match_module_records.findMany({
      where: { round_channel_id: roundChannelId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toDomain);
  }

  async complete(threadId, { result, completedAt }) {
    const row = await this.prisma.match_module_records.update({
      where: { thread_id: threadId },
      data: {
        status: 'completed',
        result: result ? JSON.stringify(result) : null,
        completed_at: completedAt ?? new Date(),
      },
    });
    return toDomain(row);
  }
}

export default { PrismaMatchRepository };
