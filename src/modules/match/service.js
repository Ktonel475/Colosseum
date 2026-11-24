import { ChannelType } from 'discord.js';
import { createTranslator } from '../../utils/i18n.js';

const t = createTranslator('match');

/** Error carrying a locale key so handlers can localize it. */
export class MatchModuleError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.name = 'MatchModuleError';
    this.key = key;
    this.params = params;
  }
}

/**
 * Best display name for a Discord User/GuildMember. The immutable identifier is
 * always `id`; names are display-only.
 */
export function userDisplayName(user) {
  return user?.displayName || user?.globalName || user?.username || String(user?.id ?? 'unknown');
}

/** Convert a resolved User/GuildMember into the module's team reference. */
export function toTeamRef(user) {
  return { id: user.id, name: userDisplayName(user) };
}

/**
 * Create one match thread in the round channel and persist the record.
 * The channel is implicit: callers pass the interaction's current channel.
 */
export async function createMatch({ roundChannel, team1, team2, locale, repository }) {
  if (!team1?.id || !team2?.id) {
    throw new MatchModuleError('missing_team');
  }
  if (team1.id === team2.id) throw new MatchModuleError('self_match_error');
  if (!roundChannel?.threads?.create) throw new MatchModuleError('round_channel_required');

  const name = t(locale, 'thread_name_template', {
    team1: team1.name,
    team2: team2.name,
  }).slice(0, 100);

  let thread;
  try {
    thread = await roundChannel.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Match ${team1.id} vs ${team2.id}`,
    });
  } catch (err) {
    throw new MatchModuleError('match_create_failed', { error: err?.message ?? String(err) });
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

/** Create N matches, collecting per-pair success/failure instead of aborting. */
export async function createBulkMatches({ roundChannel, pairs, locale, repository }) {
  const results = [];
  for (const pair of pairs) {
    try {
      const created = await createMatch({
        roundChannel,
        team1: pair.team1,
        team2: pair.team2,
        locale,
        repository,
      });
      results.push({ ok: true, pair, ...created });
    } catch (err) {
      const error =
        err instanceof MatchModuleError ? t(locale, err.key, err.params) : err?.message ?? String(err);
      results.push({ ok: false, pair, error });
    }
  }
  return results;
}

export async function findMatchByThread(repository, threadId) {
  return repository.findByThreadId(threadId);
}

/**
 * Persist the winner decided by an admin and mark the match completed.
 */
export async function recordResult({ threadId, winner, decidedBy, repository }) {
  if (winner !== 'team1' && winner !== 'team2') {
    throw new MatchModuleError('invalid_winner');
  }
  const match = await repository.findByThreadId(threadId);
  if (!match) throw new MatchModuleError('result_outside_thread');
  if (match.status === 'completed' || match.result) {
    throw new MatchModuleError('result_already_completed');
  }

  const winnerId = winner === 'team1' ? match.team1Id : match.team2Id;
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
  toTeamRef,
  createMatch,
  createBulkMatches,
  findMatchByThread,
  recordResult,
};
