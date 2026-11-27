import { ChannelType } from "discord.js";
import { createTranslator } from "../../utils/i18n.js";

const t = createTranslator("match");

/** Error carrying a locale key so handlers can localize it. */
export class MatchModuleError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = "MatchModuleError";
    this.key = key;
    this.params = params;
  }
}

/** Best display name for a Discord User/GuildMember. */
export function userDisplayName(user) {
  return (
    user?.displayName ||
    user?.globalName ||
    user?.username ||
    String(user?.id ?? "unknown")
  );
}

/** True if value is a Discord snowflake (17–20 digits). */
function isSnowflake(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

/**
 * Resolve a Discord Role by its exact display name in a guild.
 * Returns the Role (with numeric .id) or null.
 * Uses cache first, then fetches if not found.
 */
export async function resolveRoleByName(guild, roleName) {
  if (!guild || !roleName) return null;

  // Fast path: cache
  const cached = guild.roles?.cache?.find?.((r) => r.name === roleName);
  if (cached) return cached;

  // Slow path: fetch all roles
  try {
    const all = await guild.roles.fetch();
    return all.find((r) => r.name === roleName) ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert a resolved team Role into the module's team reference.
 * `roleId` MUST be a numeric snowflake for `<@&id>` to ping.
 */
export function toTeamRef(role, name) {
  return {
    id: role.id,
    name: name ?? role.name,
    roleId: role.id,
  };
}

/**
 * Build the ping string for a team:
 *   - real snowflake → "<@&1234567890>" (actual ping)
 *   - otherwise     → the team's display name (never a broken mention)
 */
function rolePing(team) {
  const roleId = team?.roleId ?? team?.discordRoleId ?? team?.id;
  if (isSnowflake(roleId)) return `<@&${roleId}>`;
  return team?.name ?? "";
}

/**
 * Build the optional admin-role ping for the intro message. Returns an empty
 * string when no valid admin role is configured, so the template stays clean.
 */
function adminRolePing(adminRoleId) {
  return isSnowflake(adminRoleId) ? ` <@&${adminRoleId}>` : "";
}

/**
 * Turn a stored team role id (or name) into a pingable team ref.
 * `team` can be `{ name, roleId? | discordRoleId? }` or a plain string
 * (treated as a name). Throws `team_role_not_found` if `requireRole` is true
 * and no role matches.
 */
export async function resolveTeamRef(
  guild,
  team,
  { requireRole = false } = {},
) {
  const name = typeof team === "string" ? team : team?.name;
  if (!name) throw new MatchModuleError("missing_team");

  // Prefer an explicit stored numeric roleId (`<@&id>` pings need a snowflake).
  const storedId =
    typeof team === "object" ? team?.roleId ?? team?.discordRoleId : null;
  if (isSnowflake(storedId)) {
    let role = guild?.roles?.cache?.get?.(storedId) ?? null;
    if (!role && typeof guild?.roles?.fetch === "function") {
      role = await guild.roles.fetch(storedId).catch(() => null);
    }
    if (role) return toTeamRef(role, name);
  }

  // Fall back to lookup by name
  const role = await resolveRoleByName(guild, name);
  if (role) return toTeamRef(role, name);

  if (requireRole) {
    throw new MatchModuleError("team_role_not_found", { team: name });
  }

  // Last resort: plain name (no ping)
  return { id: name, name, roleId: null };
}

/**
 * Enrich a team ref with its Discord role id so the intro message can ping
 * the team via `<@&roleId>`. Keeps the team identity (id / name) intact.
 * When `requireRole` is true and no role matches, raises `team_role_not_found`.
 * Otherwise falls back to `roleId: null` and the plain team name.
 */
export async function resolveTeamPing(
  team,
  { guild = null, requireRole = false } = {},
) {
  const ref = await resolveTeamRef(
    guild,
    { name: team?.name, discordRoleId: team?.discordRoleId ?? null },
    { requireRole },
  );
  return { ...team, roleId: ref.roleId ?? team?.discordRoleId ?? null };
}

/** Create one match thread and persist the record. */
export async function createMatch({
  roundChannel,
  team1,
  team2,
  locale,
  repository,
  adminRoleId = null,
}) {
  if (!team1?.id || !team2?.id) throw new MatchModuleError("missing_team");
  if (team1.id === team2.id) throw new MatchModuleError("self_match_error");
  if (!roundChannel?.threads?.create)
    throw new MatchModuleError("round_channel_required");

  const name = t(locale, "thread_name_template", {
    team1: team1.name,
    team2: team2.name,
  }).slice(0, 100);

  // Resolve pings before creating the thread.
  const team1Ping = rolePing(team1);
  const team2Ping = rolePing(team2);
  const adminPing = adminRolePing(adminRoleId);

  let thread;
  try {
    thread = await roundChannel.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Match ${team1.id} vs ${team2.id}`,
    });

    await thread.send(
      t(locale, "thread_intro", {
        team1Ping,
        team2Ping,
        adminPing,
        team1: team1.name,
        team2: team2.name,
        resultTemplate: t(locale, "result_submission_template", {
          team1: team1.name,
          team2: team2.name,
        }),
      }),
    );
  } catch (err) {
    if (thread) await Promise.resolve(thread.delete?.()).catch(() => {});
    throw new MatchModuleError("match_create_failed", {
      error: err?.message ?? String(err),
    });
  }

  try {
    const record = await repository.create({
      roundChannelId: roundChannel.id,
      threadId: thread.id,
      team1Id: team1.id,
      team2Id: team2.id,
    });
    return { record, thread };
  } catch (err) {
    await Promise.resolve(thread.delete?.()).catch(() => {});
    throw err;
  }
}

/** Create N matches, collecting per-pair success/failure. */
export async function createBulkMatches({
  roundChannel,
  pairs,
  locale,
  repository,
  guild = null,
  requireRole = false,
  adminRoleId = null,
}) {
  const results = [];
  for (const pair of pairs) {
    try {
      let { team1, team2 } = pair;
      if (guild) {
        team1 = await resolveTeamPing(team1, { guild, requireRole });
        team2 = await resolveTeamPing(team2, { guild, requireRole });
      }
      const created = await createMatch({
        roundChannel,
        team1,
        team2,
        locale,
        repository,
        adminRoleId,
      });
      results.push({ ok: true, pair, ...created });
    } catch (err) {
      const error =
        err instanceof MatchModuleError
          ? t(locale, err.key, err.params)
          : (err?.message ?? String(err));
      results.push({ ok: false, pair, error });
    }
  }
  return results;
}

export async function findMatchByThread(repository, threadId) {
  return repository.findByThreadId(threadId);
}

export async function recordResult({
  threadId,
  winner,
  decidedBy,
  repository,
}) {
  if (winner !== "team1" && winner !== "team2")
    throw new MatchModuleError("invalid_winner");

  const match = await repository.findByThreadId(threadId);
  if (!match) throw new MatchModuleError("result_outside_thread");
  if (match.status === "completed" || match.result)
    throw new MatchModuleError("result_already_completed");

  const winnerId = winner === "team1" ? match.team1Id : match.team2Id;
  const completedAt = new Date();
  const result = {
    winner,
    winnerId,
    decidedBy,
    completedAt: completedAt.toISOString(),
  };
  const updated = await repository.complete(threadId, { result, completedAt });
  return { match: updated, result };
}

export default {
  MatchModuleError,
  userDisplayName,
  resolveRoleByName,
  resolveTeamRef,
  resolveTeamPing,
  toTeamRef,
  createMatch,
  createBulkMatches,
  findMatchByThread,
  recordResult,
};
