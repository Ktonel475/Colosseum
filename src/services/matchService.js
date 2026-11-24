import prisma from '../database/prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors.js';
import { t } from '../utils/i18n.js';
import { recordAudit } from './auditService.js';

export async function findMatchByThreadId(threadId, client = prisma) {
  return client.matches.findUnique({
    where: { discord_thread_id: threadId },
    include: { team1: true, team2: true, results: true },
  });
}

export async function getMatch(identifier) {
  const match = await prisma.matches.findFirst({
    where: { OR: [{ id: identifier }, { discord_thread_id: identifier }] },
    include: { team1: true, team2: true, results: { include: { confirmations: true } } },
  });
  if (!match) throw new NotFoundError('Match not found', { i18nKey: 'errors.match_not_found' });
  return match;
}

export async function listMatches({ status, teamId } = {}) {
  const where = {};
  if (status) where.status = status;
  if (teamId) where.OR = [{ team1_id: teamId }, { team2_id: teamId }];
  return prisma.matches.findMany({
    where,
    include: { team1: true, team2: true, results: true },
    orderBy: { created_at: 'desc' },
  });
}

/**
 * Create a match and its private Discord thread.
 * `guild` and `parentChannel` are discord.js objects.
 */
export async function createMatch({
  team1Identifier,
  team2Identifier,
  guild = null,
  parentChannel = null,
  actorDiscordId = 'system',
  adminRoleIds = [],
  locale = 'en',
}) {
  const team1 = await prisma.teams.findUnique({ where: { team_id: String(team1Identifier) } });
  const team2 = await prisma.teams.findUnique({ where: { team_id: String(team2Identifier) } });

  if (!team1 || !team2) {
    throw new NotFoundError('One or both teams not found', { i18nKey: 'errors.teams_not_found' });
  }
  if (!team1.is_active || !team2.is_active) {
    throw new ValidationError('Both teams must be active', undefined, {
      i18nKey: 'errors.teams_inactive',
    });
  }
  if (team1.team_id === team2.team_id) {
    throw new ValidationError('A team cannot play against itself', undefined, {
      i18nKey: 'errors.self_match',
    });
  }

  const duplicate = await prisma.matches.findFirst({
    where: {
      status: { in: ['active', 'pending'] },
      OR: [
        { team1_id: team1.team_id, team2_id: team2.team_id },
        { team1_id: team2.team_id, team2_id: team1.team_id },
      ],
    },
  });
  if (duplicate) {
    throw new ConflictError('An active match between these teams already exists', {
      i18nKey: 'errors.match_exists',
    });
  }

  const match = await prisma.matches.create({
    data: { team1_id: team1.team_id, team2_id: team2.team_id, status: 'active' },
  });

  if (!guild || !parentChannel) {
    // Without Discord context (e.g. tests), the match stays without a thread.
    await recordAudit({
      actorDiscordId,
      action: 'MATCH_CREATE',
      entityType: 'match',
      entityId: match.id,
      newValue: { team1: team1.team_id, team2: team2.team_id },
    });
    return { match, thread: null, warnings: [] };
  }

  let thread;
  try {
    thread = await parentChannel.threads.create({
      name: `${team1.team_name} vs ${team2.team_name}`.slice(0, 100),
      type: 12, // ChannelType.PrivateThread
      invitable: false,
      reason: `Match ${match.id}`,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create private match thread');
    await prisma.matches.delete({ where: { id: match.id } });
    throw new ValidationError('Failed to create the private match thread', undefined, {
      i18nKey: 'errors.thread_create_failed',
    });
  }

  const updated = await prisma.matches.update({
    where: { id: match.id },
    data: { discord_thread_id: thread.id },
  });

  const warnings = await syncThreadMembers(thread, updated, { guild, adminRoleIds });

  try {
    const ping = (team) =>
      team.discord_role_id ? `<@&${team.discord_role_id}>` : `**${team.team_name}**`;
    await thread.send(
      t(locale, 'match_legacy_thread_intro', {
        team1Ping: ping(team1),
        team2Ping: ping(team2),
        team1: team1.team_name,
        team1Id: team1.team_id,
        team2: team2.team_name,
        team2Id: team2.team_id,
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to send intro message in match thread');
  }

  await recordAudit({
    actorDiscordId,
    action: 'MATCH_CREATE',
    entityType: 'match',
    entityId: match.id,
    newValue: {
      team1: team1.team_id,
      team2: team2.team_id,
      threadId: thread.id,
    },
  });

  return { match: updated, thread, warnings };
}

/**
 * Add all registered players of both teams plus staff to a private thread.
 */
export async function syncThreadMembers(thread, match, { guild, adminRoleIds = [] } = {}) {
  const warnings = [];
  if (!guild) return warnings;

  const players = await prisma.players.findMany({
    where: { team_id: { in: [match.team1_id, match.team2_id] } },
  });

  for (const player of players) {
    try {
      const member =
        guild.members.cache.get(player.discord_user_id) ??
        (await guild.members.fetch(player.discord_user_id).catch(() => null));
      if (!member) {
        warnings.push({ discordUserId: player.discord_user_id, reason: 'member-not-found' });
        continue;
      }
      await thread.members.add(member.id);
    } catch (err) {
      logger.warn({ err, user: player.discord_user_id }, 'Failed to add player to thread');
      warnings.push({ discordUserId: player.discord_user_id, reason: err.message });
    }
  }

  for (const roleId of adminRoleIds.filter(Boolean)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    for (const member of role.members.values()) {
      try {
        await thread.members.add(member.id);
      } catch (err) {
        logger.warn({ err, user: member.id }, 'Failed to add staff to thread');
        warnings.push({ discordUserId: member.id, reason: err.message });
      }
    }
  }

  return warnings;
}

/**
 * When a player's team changes, remove them from threads of their previous
 * team's active matches and add them to threads of their new team's matches.
 */
export async function syncThreadAccessForPlayer({ guild, discordUserId, previousTeamId, newTeamId }) {
  if (!guild) return { added: [], removed: [], warnings: [] };
  const added = [];
  const removed = [];
  const warnings = [];

  if (previousTeamId && previousTeamId !== newTeamId) {
    const oldMatches = await prisma.matches.findMany({
      where: {
        status: 'active',
        discord_thread_id: { not: null },
        OR: [{ team1_id: previousTeamId }, { team2_id: previousTeamId }],
      },
    });
    for (const match of oldMatches) {
      try {
        const thread = await guild.channels.fetch(match.discord_thread_id);
        if (thread) await thread.members.remove(discordUserId);
        removed.push(match.id);
      } catch (err) {
        warnings.push({ matchId: match.id, reason: err.message });
      }
    }
  }

  if (newTeamId) {
    const newMatches = await prisma.matches.findMany({
      where: {
        status: 'active',
        discord_thread_id: { not: null },
        OR: [{ team1_id: newTeamId }, { team2_id: newTeamId }],
      },
    });
    for (const match of newMatches) {
      try {
        const thread = await guild.channels.fetch(match.discord_thread_id);
        if (thread) await thread.members.add(discordUserId);
        added.push(match.id);
      } catch (err) {
        warnings.push({ matchId: match.id, reason: err.message });
      }
    }
  }

  return { added, removed, warnings };
}

export async function closeMatch(identifier, actorDiscordId = 'system', { guild, archive = true } = {}) {
  const match = await getMatch(identifier);
  if (match.status === 'closed') return match;

  const updated = await prisma.matches.update({
    where: { id: match.id },
    data: { status: 'closed' },
  });

  if (guild && match.discord_thread_id) {
    try {
      const thread = await guild.channels.fetch(match.discord_thread_id);
      if (thread) {
        // A closed match no longer needs its private thread: remove it.
        if (typeof thread.delete === 'function') {
          await thread.delete('Match closed');
        } else {
          if (archive && typeof thread.setArchived === 'function') {
            await thread.setArchived(true);
          }
          if (typeof thread.setLocked === 'function') {
            await thread.setLocked(true);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to archive/lock match thread');
    }
  }

  await recordAudit({
    actorDiscordId,
    action: 'MATCH_CLOSE',
    entityType: 'match',
    entityId: match.id,
    previousValue: { status: match.status },
    newValue: { status: 'closed' },
  });

  return updated;
}

export default {
  findMatchByThreadId,
  getMatch,
  listMatches,
  createMatch,
  syncThreadMembers,
  syncThreadAccessForPlayer,
  closeMatch,
};
