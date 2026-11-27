import * as teamService from '../../services/teamService.js';

/**
 * Team catalog adapter used by the match module.
 *
 * The module stores team *codes* (`team_id`) as the immutable identifier and
 * uses the team display name only for thread titles and result embeds. Keeping
 * the lookup here means handlers never depend on Discord user selection.
 */

/** List active teams, optionally filtered by a name/code query. */
export async function listActiveTeams({ query = '', limit = 25 } = {}) {
  const teams = await teamService.listTeams({});
  const needle = String(query ?? '').trim().toLowerCase();
  const matches = needle
    ? teams.filter((team) =>
        `${team.team_id} ${team.team_name} ${team.game_type ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : teams;
  return matches.slice(0, limit);
}

/** Resolve a team code or name into a match-module team reference. */
export async function resolveTeamRef(identifier) {
  const value = String(identifier ?? '').trim();
  const team = await teamService.getTeam(value);
  return {
    id: team.team_id,
    name: team.team_name,
    gameType: team.game_type ?? null,
    discordRoleId: team.discord_role_id ?? null,
  };
}

export default { listActiveTeams, resolveTeamRef };
