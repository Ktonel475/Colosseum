import { randomUUID } from 'node:crypto';

function clone(record) {
  return { ...record, result: record.result ? { ...record.result } : null };
}

/**
 * In-memory implementation of the match repository contract. Used by tests and
 * by anyone extracting the module without Prisma.
 *
 * Contract:
 *   create({ roundChannelId, threadId, team1Id, team2Id }) -> record
 *   findByThreadId(threadId) -> record | null
 *   listByRound(roundChannelId) -> record[]
 *   complete(threadId, { result, completedAt }) -> record
 */
export class MemoryMatchRepository {
  constructor() {
    this.records = new Map();
  }

  async create({ roundChannelId, threadId, team1Id, team2Id }) {
    const record = {
      id: randomUUID(),
      roundChannelId,
      threadId,
      team1Id,
      team2Id,
      status: 'active',
      result: null,
      createdAt: new Date(),
      completedAt: null,
    };
    this.records.set(threadId, record);
    return clone(record);
  }

  async findByThreadId(threadId) {
    const record = this.records.get(threadId);
    return record ? clone(record) : null;
  }

  async listByRound(roundChannelId) {
    return [...this.records.values()]
      .filter((record) => record.roundChannelId === roundChannelId)
      .map(clone);
  }

  async complete(threadId, { result, completedAt }) {
    const record = this.records.get(threadId);
    if (!record) return null;
    record.status = 'completed';
    record.result = result ? { ...result } : null;
    record.completedAt = completedAt ?? new Date();
    return clone(record);
  }

  clear() {
    this.records.clear();
  }
}

export default { MemoryMatchRepository };
