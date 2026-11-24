import prisma from '../database/prisma.js';
import logger from '../utils/logger.js';

/**
 * Persist an audit log entry. Values are stored as JSON strings because SQLite
 * does not support the Prisma Json type.
 */
export async function recordAudit({
  actorDiscordId,
  action,
  entityType,
  entityId,
  previousValue = null,
  newValue = null,
  client = prisma,
}) {
  try {
    await client.audit_logs.create({
      data: {
        actor_discord_id: String(actorDiscordId ?? 'system'),
        action,
        entity_type: entityType,
        entity_id: String(entityId),
        previous_value: previousValue === null ? null : JSON.stringify(previousValue),
        new_value: newValue === null ? null : JSON.stringify(newValue),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log');
  }
}

export async function listAuditLogs({ entityType, entityId, limit = 100 } = {}) {
  const where = {};
  if (entityType) where.entity_type = entityType;
  if (entityId) where.entity_id = String(entityId);
  return prisma.audit_logs.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: limit,
  });
}

export default { recordAudit, listAuditLogs };
