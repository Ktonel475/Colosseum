import prisma from '../database/prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { recordAudit } from './auditService.js';
import { resolveTeamRoleName } from './teamService.js';

export async function getPlayerByDiscordId(discordUserId, client = prisma) {
  return client.players.findUnique({
    where: { discord_user_id: discordUserId },
    include: { team: true },
  });
}

export async function listPlayers({ teamId, search, includeInactiveTeams = false } = {}) {
  const where = {};
  if (teamId) where.team_id = teamId;
  if (search) where.discord_username = { contains: search };
  if (!includeInactiveTeams) where.team = { is_active: true };
  return prisma.players.findMany({
    where,
    include: { team: true },
    orderBy: { discord_username: 'asc' },
  });
}

export async function findPlayersForTeam(teamId, client = prisma) {
  return client.players.findMany({ where: { team_id: teamId } });
}

/**
 * Development helper: put the invoking Discord user into the initial player
 * state (registered, no team). Safe to call repeatedly; clears any team
 * assignment in the database so `/regist` can be tested from scratch.
 */
export async function initializePlayer({
  discordUserId,
  discordUsername,
  actorDiscordId = discordUserId,
  client = prisma,
}) {
  const username = String(discordUsername ?? '').trim();
  if (!username) {
    throw new ValidationError('A username is required', undefined, {
      i18nKey: 'errors.username_required',
    });
  }

  const existing = await client.players.findUnique({ where: { discord_user_id: discordUserId } });
  const player = await client.players.upsert({
    where: { discord_user_id: discordUserId },
    update: { discord_username: username, team_id: null, team_role_id: null },
    create: { discord_user_id: discordUserId, discord_username: username },
  });

  await recordAudit({
    actorDiscordId,
    action: 'PLAYER_INIT',
    entityType: 'player',
    entityId: player.id,
    previousValue: existing
      ? { discord_username: existing.discord_username, team_id: existing.team_id }
      : null,
    newValue: { discord_username: username, team_id: null },
  });

  return { player, previousTeamId: existing?.team_id ?? null };
}

/**
 * Search active teams for the selection UI.
 */
export async function searchActiveTeams(query, limit = 25, client = prisma) {
  const q = String(query ?? '').trim().toLowerCase();
  const teams = await client.teams.findMany({
    where: { is_active: true },
    orderBy: { team_name: 'asc' },
  });
  if (!q) return teams.slice(0, limit);
  return teams
    .filter((t) => `${t.team_name} ${t.team_id}`.toLowerCase().includes(q))
    .slice(0, limit);
}

/**
 * Assign (or change) a player's team.
 *
 * Ordering: validate -> add new Discord role -> persist DB -> remove old roles.
 * If Discord fails before the DB write we abort with no DB change. If the old
 * role removal fails after the DB write, we log and surface a warning but the
 * database remains the source of truth.
 *
 * @param {object} params
 * @param {string} params.discordUserId
 * @param {string} params.discordUsername
 * @param {string} params.teamId internal team id
 * @param {object} [params.guild] discord.js Guild
 * @param {object} [params.member] discord.js GuildMember
 */
export async function assignTeam({
  discordUserId,
  discordUsername = 'Unknown',
  teamId,
  guild = null,
  member = null,
  actorDiscordId = discordUserId,
}) {
  const team = await prisma.teams.findUnique({ where: { team_id: teamId } });
  if (!team || !team.is_active) {
    throw new ValidationError('Selected team is not active', undefined, {
      i18nKey: 'errors.team_inactive',
    });
  }

  const existing = await prisma.players.findUnique({
    where: { discord_user_id: discordUserId },
  });
  const previousTeamId = existing?.team_id ?? null;
  const previousRoleId = existing?.team_role_id ?? null;

  let newRoleId = team.discord_role_id ?? null;
  let roleAddWarning = null;

  // 1. Add the new role first (when Discord context is available).
  if (guild && member) {
    try {
      let role = newRoleId ? guild.roles.cache.get(newRoleId) : null;
      if (!role) {
        const roleName = await resolveTeamRoleName(team);
        role = guild.roles.cache.find((r) => r.name === roleName) ?? null;
        if (!role) {
          role = await guild.roles.create({ name: roleName, mentionable: true, reason: 'Competition team role' });
        }
      }
      newRoleId = role.id;
      if (team.discord_role_id !== role.id) {
        await prisma.teams.update({
          where: { team_id: team.team_id },
          data: { discord_role_id: role.id },
        });
      }
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, 'Team assignment');
      }
    } catch (err) {
      logger.error({ err, discordUserId, teamId }, 'Failed to add team role');
      throw new ValidationError(
        'Could not assign the Discord role. No changes were saved. Please try again later.',
        undefined,
        { i18nKey: 'errors.role_assign_failed' },
      );
    }
  }

  // 2. Persist assignment in a transaction.
  const player = await prisma.$transaction(async (tx) => {
    const saved = existing
      ? await tx.players.update({
          where: { id: existing.id },
          data: {
            discord_username: discordUsername,
            team_id: team.team_id,
            team_role_id: newRoleId,
            updated_at: new Date(),
          },
        })
      : await tx.players.create({
          data: {
            discord_user_id: discordUserId,
            discord_username: discordUsername,
            team_id: team.team_id,
            team_role_id: newRoleId,
          },
        });
    return saved;
  });

  // 3. Remove the previous role / any stale team roles.
  if (guild && member) {
    try {
      const teamRoleIds = new Set(
        (await prisma.teams.findMany({ select: { discord_role_id: true } }))
          .map((t) => t.discord_role_id)
          .filter(Boolean),
      );
      const stale = member.roles.cache.filter(
        (r) => teamRoleIds.has(r.id) && r.id !== newRoleId,
      );
      for (const role of stale.values()) {
        await member.roles.remove(role, 'Team change');
      }
      if (previousRoleId && previousRoleId !== newRoleId && previousRoleId !== newRoleId) {
        // already covered by stale filter, guard defensively
      }
    } catch (err) {
      logger.warn({ err, discordUserId }, 'Failed to remove old team role(s)');
      roleAddWarning = 'Old team role could not be removed automatically. Contact an administrator.';
    }
  }

  await recordAudit({
    actorDiscordId,
    action: previousTeamId ? 'PLAYER_TEAM_CHANGE' : 'PLAYER_TEAM_ASSIGN',
    entityType: 'player',
    entityId: player.id,
    previousValue: previousTeamId
      ? { team_id: previousTeamId, role_id: previousRoleId }
      : null,
    newValue: { team_id: team.team_id, team_name: team.team_name, role_id: newRoleId },
  });

  // Clear pending selection sessions.
  await prisma.player_selections.deleteMany({
    where: { discord_user_id: discordUserId, status: 'awaiting_selection' },
  });

  return { player, team, previousTeamId, warning: roleAddWarning };
}

export async function createSelectionSession({ discordUserId, discordUsername, guildId }) {
  const expiration = new Date(Date.now() + 5 * 60 * 1000);
  return prisma.player_selections.create({
    data: {
      discord_user_id: discordUserId,
      discord_username: discordUsername,
      guild_id: guildId,
      status: 'awaiting_selection',
      expiration,
    },
  });
}

export async function getActiveSelectionSession(discordUserId, client = prisma) {
  const session = await client.player_selections.findFirst({
    where: { discord_user_id: discordUserId, status: 'awaiting_selection' },
    orderBy: { created_at: 'desc' },
  });
  if (!session) return null;
  if (session.expiration < new Date()) return null;
  return session;
}

export default {
  getPlayerByDiscordId,
  listPlayers,
  findPlayersForTeam,
  searchActiveTeams,
  initializePlayer,
  assignTeam,
  createSelectionSession,
  getActiveSelectionSession,
};
