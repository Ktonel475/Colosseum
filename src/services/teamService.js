import { z } from 'zod';
import prisma from '../database/prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors.js';
import { recordAudit } from './auditService.js';
import { describeCategory, normalizeGameType, teamNameKey } from '../utils/teamIdentity.js';

const TeamInput = z.object({
  team_id: z.string().trim().min(1),
  team_name: z.string().trim().min(1),
  game_type: z.string().trim().max(100).optional().nullable(),
});

/** Build an import preview without writing anything. */
export async function previewImport(rows, client = prisma) {
  const existing = await client.teams.findMany();
  const byExternalId = new Map(existing.map((t) => [t.team_id.toLowerCase(), t]));
  const byName = new Map(existing.map((t) => [teamNameKey(t.team_name, t.game_type), t]));

  const newTeams = [];
  const updatedTeams = [];
  const incomingIds = new Set();

  for (const row of rows) {
    incomingIds.add(row.team_id.toLowerCase());
    const existingTeam = byExternalId.get(row.team_id.toLowerCase());

    if (!existingTeam) {
      const nameCollision = byName.get(teamNameKey(row.team_name, row.game_type));
      if (nameCollision) {
        updatedTeams.push({
          team_id: row.team_id,
          team_name: row.team_name,
          game_type: row.game_type ?? null,
          existingId: nameCollision.team_id,
          reason: 'name-matches-other-team',
        });
      } else {
        newTeams.push(row);
      }
      continue;
    }

    const incomingGame = normalizeGameType(row.game_type);
    const nextGameType = incomingGame ?? existingTeam.game_type ?? null;
    const nameChanged = existingTeam.team_name !== row.team_name;
    const gameChanged = incomingGame !== null && incomingGame !== normalizeGameType(existingTeam.game_type);
    const nameClash =
      nameChanged && byName.has(teamNameKey(row.team_name, nextGameType)) &&
      byName.get(teamNameKey(row.team_name, nextGameType)).team_id !== existingTeam.team_id;

    if (nameChanged || gameChanged || nameClash) {
      updatedTeams.push({
        team_id: row.team_id,
        team_name: row.team_name,
        game_type: row.game_type ?? null,
        existingId: existingTeam.team_id,
        reason: nameClash ? 'name-matches-other-team' : nameChanged ? 'name-changed' : 'game-type-changed',
      });
    }
  }

  const removedTeams = existing
    .filter((t) => t.is_active && !incomingIds.has(t.team_id.toLowerCase()))
    .map((t) => ({ team_id: t.team_id, team_name: t.team_name }));

  return {
    counts: {
      incoming: rows.length,
      new: newTeams.length,
      updated: updatedTeams.length,
      removed: removedTeams.length,
    },
    newTeams,
    updatedTeams,
    removedTeams,
  };
}

/**
 * Apply an import. New rows are created, changed rows updated, and teams that
 * disappear from the source are marked inactive (never deleted).
 */
export async function applyImport(rows, { actorDiscordId = 'system', skipNames = [] } = {}) {
  const existing = await prisma.teams.findMany();
  const byId = new Map(existing.map((t) => [t.team_id.toLowerCase(), t]));
  const byName = new Map(existing.map((t) => [teamNameKey(t.team_name, t.game_type), t]));

  const created = [];
  const updated = [];
  const deactivated = [];
  const incomingIds = new Set(rows.map((r) => r.team_id.toLowerCase()));

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      if (skipNames.includes(row.team_name)) continue;
      const probe = TeamInput.safeParse(row);
      if (!probe.success) {
        throw new ValidationError(`Invalid team row: ${JSON.stringify(row)}`, undefined, {
          i18nKey: 'errors.invalid_team_row',
        });
      }
      const gameType = normalizeGameType(row.game_type);
      const match = byId.get(row.team_id.toLowerCase());

      if (!match) {
        const nameClash = byName.get(teamNameKey(row.team_name, gameType));
        if (nameClash) {
          throw new ConflictError(
            `Team name '${row.team_name}' already belongs to team ${nameClash.team_id} ` +
              `in ${describeCategory(gameType)}`,
            {
              i18nKey: 'errors.team_name_conflict',
              i18nParams: {
                team: row.team_name,
                code: nameClash.team_id,
                category: describeCategory(gameType),
              },
            },
          );
        }
        const team = await tx.teams.create({
          data: {
            team_id: row.team_id,
            team_name: row.team_name,
            game_type: gameType,
            is_active: true,
          },
        });
        created.push(team);
        continue;
      }

      const nameChanged = match.team_name !== row.team_name;
      const gameChanged = gameType !== null && normalizeGameType(match.game_type) !== gameType;
      const nextGameType = gameType ?? match.game_type ?? null;

      if (nameChanged || gameChanged || !match.is_active) {
        const clash = byName.get(teamNameKey(row.team_name, nextGameType));
        if (clash && clash.team_id !== match.team_id && (nameChanged || gameChanged)) {
          throw new ConflictError(
            `Team name '${row.team_name}' already belongs to team ${clash.team_id} ` +
              `in ${describeCategory(nextGameType)}`,
            {
              i18nKey: 'errors.team_name_conflict',
              i18nParams: {
                team: row.team_name,
                code: clash.team_id,
                category: describeCategory(nextGameType),
              },
            },
          );
        }
        const team = await tx.teams.update({
          where: { team_id: match.team_id },
          data: {
            team_name: row.team_name,
            game_type: nextGameType,
            is_active: true,
          },
        });
        updated.push({ before: match, after: team });
      }
    }

    for (const team of existing) {
      if (team.is_active && !incomingIds.has(team.team_id.toLowerCase())) {
        const deactivatedTeam = await tx.teams.update({
          where: { team_id: team.team_id },
          data: { is_active: false },
        });
        deactivated.push(deactivatedTeam);
      }
    }
  });

  await recordAudit({
    actorDiscordId,
    action: 'TEAM_IMPORT',
    entityType: 'team',
    entityId: 'batch',
    newValue: {
      created: created.map((t) => t.team_id),
      updated: updated.map((u) => u.after.team_id),
      deactivated: deactivated.map((t) => t.team_id),
    },
  });

  logger.info(
    { created: created.length, updated: updated.length, deactivated: deactivated.length },
    'Team import applied',
  );

  return { created, updated, deactivated };
}

export async function addTeam({ team_id, team_name, game_type }, actorDiscordId = 'system') {
  const parsed = TeamInput.safeParse({ team_id, team_name, game_type });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message, undefined, {
      i18nKey: 'errors.invalid_team_input',
    });
  }

  const normalizedGame = normalizeGameType(parsed.data.game_type);
  const existing = await prisma.teams.findFirst({
    where: {
      OR: [
        { team_id: parsed.data.team_id },
        { team_name: parsed.data.team_name, game_type: normalizedGame },
      ],
    },
  });
  if (existing) {
    throw new ConflictError(
      'A team with that code, or that name in the same game type, already exists',
      { i18nKey: 'errors.team_exists' },
    );
  }

  const team = await prisma.teams.create({
    data: {
      team_id: parsed.data.team_id,
      team_name: parsed.data.team_name,
      game_type: normalizedGame,
      is_active: true,
    },
  });

  await recordAudit({
    actorDiscordId,
    action: 'TEAM_ADD',
    entityType: 'team',
    entityId: team.team_id,
    newValue: {
      team_id: team.team_id,
      team_name: team.team_name,
      game_type: team.game_type,
    },
  });

  return team;
}

export async function deactivateTeam(identifier, actorDiscordId = 'system') {
  let team = await prisma.teams.findUnique({ where: { team_id: String(identifier) } });
  if (!team) {
    const matches = await prisma.teams.findMany({ where: { team_name: String(identifier) } });
    if (matches.length > 1) {
      throw new ValidationError(
        `Multiple teams are named '${identifier}' (${matches.map((t) => t.team_id).join(', ')}). ` +
          'Use the team code (รหัสทีม) instead.',
        undefined,
        {
          i18nKey: 'errors.multiple_teams_named',
          i18nParams: {
            name: identifier,
            codes: matches.map((t) => t.team_id).join(', '),
          },
        },
      );
    }
    team = matches[0] ?? null;
  }
  if (!team) throw new NotFoundError('Team not found', { i18nKey: 'errors.team_not_found' });
  if (!team.is_active) return team;

  const updated = await prisma.teams.update({
    where: { team_id: team.team_id },
    data: { is_active: false },
  });

  await recordAudit({
    actorDiscordId,
    action: 'TEAM_DEACTIVATE',
    entityType: 'team',
    entityId: team.team_id,
    previousValue: { is_active: true, team_name: team.team_name },
    newValue: { is_active: false },
  });

  return updated;
}

export async function listTeams({ includeInactive = false, search, gameType } = {}) {
  const where = {};
  if (!includeInactive) where.is_active = true;
  if (search) where.team_name = { contains: search };
  if (gameType) where.game_type = gameType;
  return prisma.teams.findMany({ where, orderBy: { team_name: 'asc' } });
}

export async function getTeam(identifier) {
  if (identifier === undefined || identifier === null || identifier === '') {
    throw new NotFoundError('Team not found', { i18nKey: 'errors.team_not_found' });
  }
  const team = await prisma.teams.findUnique({
    where: { team_id: String(identifier) },
    include: { players: true },
  });
  if (team) return team;

  const matches = await prisma.teams.findMany({
    where: { team_name: String(identifier) },
    include: { players: true },
  });
  if (matches.length > 1) {
    throw new ValidationError(
      `Multiple teams are named '${identifier}' (${matches.map((t) => t.team_id).join(', ')}). ` +
        'Use the team code (รหัสทีม) instead.',
      undefined,
      {
        i18nKey: 'errors.multiple_teams_named',
        i18nParams: {
          name: identifier,
          codes: matches.map((t) => t.team_id).join(', '),
        },
      },
    );
  }
  if (matches.length === 1) return matches[0];
  throw new NotFoundError('Team not found', { i18nKey: 'errors.team_not_found' });
}

/**
 * Discord role names are not unique, but two teams sharing one name would end
 * up sharing a single role. When a name is used by several active teams the
 * game type (or team code) is appended so each team gets its own role.
 */
export async function resolveTeamRoleName(team) {
  const sameName = await prisma.teams.count({
    where: { team_name: team.team_name, is_active: true },
  });
  if (sameName <= 1) return team.team_name;
  return `${team.team_name} [${team.game_type ?? team.team_id}]`.slice(0, 100);
}

/**
 * Ensure a Discord role exists for every active team and store its ID.
 * `guild` is a discord.js Guild. Returns a per-team result summary.
 */
export async function syncTeamRoles(guild, actorDiscordId = 'system') {
  if (!guild) {
    throw new ValidationError('A Discord guild is required for role sync', undefined, {
      i18nKey: 'errors.guild_required',
    });
  }
  const teams = await prisma.teams.findMany({ where: { is_active: true } });
  const results = [];

  for (const team of teams) {
    try {
      const roleName = await resolveTeamRoleName(team);
      let role =
        (team.discord_role_id && guild.roles.cache.get(team.discord_role_id)) ||
        guild.roles.cache.find((r) => r.name === roleName) ||
        null;

      if (!role) {
        role = await guild.roles.create({
          name: roleName,
          mentionable: true,
          reason: 'Competition team role',
        });
        results.push({ team: team.team_id, action: 'created', roleId: role.id });
      } else if (role.name !== roleName) {
        await role.setName(roleName, 'Sync team name');
        results.push({ team: team.team_id, action: 'renamed', roleId: role.id });
      } else {
        results.push({ team: team.team_id, action: 'unchanged', roleId: role.id });
      }

      // Team roles must be mentionable so match threads can ping them.
      if (typeof role.setMentionable === 'function' && role.mentionable === false) {
        await role.setMentionable(true, 'Allow match pings').catch(() => {});
      }

      if (team.discord_role_id !== role.id) {
        await prisma.teams.update({
          where: { team_id: team.team_id },
          data: { discord_role_id: role.id },
        });
      }
    } catch (err) {
      logger.error({ err, team: team.team_id }, 'Failed to sync team role');
      results.push({ team: team.team_id, action: 'error', error: err.message });
    }
  }

  await recordAudit({
    actorDiscordId,
    action: 'TEAM_ROLE_SYNC',
    entityType: 'team',
    entityId: 'batch',
    newValue: results,
  });

  return results;
}

/**
 * Resolve a team's Discord role, creating it if missing. Used during import.
 */
export async function ensureTeamRole(guild, team, actorDiscordId = 'system') {
  if (!guild) return team.discord_role_id ?? null;
  if (team.discord_role_id && guild.roles.cache.get(team.discord_role_id)) {
    return team.discord_role_id;
  }
  const roleName = await resolveTeamRoleName(team);
  const existing = guild.roles.cache.find((r) => r.name === roleName);
  const role = existing ?? (await guild.roles.create({ name: roleName, mentionable: true, reason: 'Competition team role' }));
  await prisma.teams.update({
    where: { team_id: team.team_id },
    data: { discord_role_id: role.id },
  });
  await recordAudit({
    actorDiscordId,
    action: 'TEAM_ROLE_CREATE',
    entityType: 'team',
    entityId: team.team_id,
    newValue: { discord_role_id: role.id },
  });
  return role.id;
}

export default {
  previewImport,
  applyImport,
  addTeam,
  deactivateTeam,
  listTeams,
  getTeam,
  resolveTeamRoleName,
  syncTeamRoles,
  ensureTeamRole,
};
