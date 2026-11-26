import { MessageFlags } from 'discord.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { createTranslator, interactionLocale } from '../../utils/i18n.js';
import {
  MatchModuleError,
  createBulkMatches,
  createMatch,
  recordResult,
  resolveTeamPing,
} from './service.js';
import { listActiveTeams, resolveTeamRef as resolveTeamRefById } from './teams.js';
import { createRepository } from './repository/index.js';
import {
  createBulkSession,
  createResultConfirmation,
  deleteBulkSession,
  deleteResultConfirmation,
  getBulkSession,
  peekResultConfirmation,
  takeResultConfirmation,
} from './state.js';
import {
  buildBulkPanel,
  buildBulkSummary,
  buildResultConfirmRow,
  buildResultEmbed,
  buildWinnerSelect,
} from './ui.js';

const t = createTranslator('match');
const eph = { flags: MessageFlags.Ephemeral };
const defaultRepository = createRepository();

function hasRole(interaction, roleId) {
  if (!roleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roleId));
}

function isCreator(interaction) {
  return hasRole(interaction, config.discord.adminRoleId);
}

function isMatchAdmin(interaction) {
  return hasRole(interaction, config.discord.adminRoleId);
}

function errorContent(locale, err) {
  if (err instanceof MatchModuleError) return t(locale, err.key, err.params);
  return t(locale, 'generic_error', { error: err?.message ?? String(err) });
}

async function replyError(interaction, locale, err) {
  const content = errorContent(locale, err);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content, components: [] }).catch(() => {});
  }
  return interaction.reply({ content, components: [], ...eph }).catch(() => {});
}

async function updateError(interaction, locale, err) {
  const content = errorContent(locale, err);
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content, components: [] }).catch(() => {});
  }
  return interaction.update({ content, components: [] }).catch(() =>
    interaction.reply({ content, components: [], ...eph }).catch(() => {}),
  );
}

async function resolveTeamName(_interaction, teamId) {
  try {
    const team = await resolveTeamRefById(teamId);
    return team.name;
  } catch {
    return String(teamId);
  }
}

/** Guild used for role lookups: the interaction's guild or the bot's first guild. */
function interactionGuild(interaction) {
  return interaction.guild ?? interaction.client?.guilds?.cache?.first?.() ?? null;
}

/**
 * Resolve a team supplied as a command option (name or code) into a team ref.
 * Missing or ambiguous teams become a localized module error. The Discord role
 * (used for the intro ping) is resolved separately by `resolveTeamPing`.
 */
async function resolveTeamOption(interaction, optionName) {
  const identifier = interaction.options.getString(optionName, true);
  const team = await resolveTeamRefById(identifier).catch(() => null);
  if (!team) throw new MatchModuleError('team_not_found', { team: identifier });
  return team;
}

/** Fetch the active team catalog used by the bulk panel select menus. */
async function loadTeams() {
  return listActiveTeams({ limit: 25 });
}

async function showBulkPanel(interaction, locale, token, session) {
  const teams = await loadTeams();
  if (!teams.length) {
    return interaction.reply({ content: t(locale, 'no_teams'), ...eph });
  }
  return interaction.reply({ ...buildBulkPanel({ locale, token, session, teams }), ...eph });
}

async function updateBulkPanel(interaction, locale, token, session) {
  const teams = await loadTeams();
  if (!teams.length) {
    return updateError(interaction, locale, new MatchModuleError('no_teams'));
  }
  return interaction.update(buildBulkPanel({ locale, token, session, teams }));
}

/**
 * Round channel resolution: an explicit `channel` option wins, otherwise the
 * channel where the command was used. The channel must be able to host private
 * threads, so threads themselves are rejected.
 */
function resolveRoundChannel(interaction) {
  const selected = interaction.options?.getChannel?.('channel') ?? null;
  const channel = selected ?? interaction.channel;
  if (!channel?.threads?.create) return null;
  return channel;
}

/* ------------------------------ commands -------------------------------- */

async function handleMatchCreate(interaction, repository = defaultRepository) {
  const locale = interactionLocale(interaction);
  try {
    if (!isCreator(interaction)) {
      return interaction.reply({ content: t(locale, 'role_gate_denied'), ...eph });
    }
    const roundChannel = resolveRoundChannel(interaction);
    if (!roundChannel) {
      return interaction.reply({ content: t(locale, 'round_channel_required'), ...eph });
    }

    const team1 = await resolveTeamOption(interaction, 'team1');
    const team2 = await resolveTeamOption(interaction, 'team2');
    if (team1.id === team2.id) {
      return interaction.reply({ content: t(locale, 'self_match_error'), ...eph });
    }

    // Resolve the Discord roles so the intro can ping both teams. When
    // `require_role` is enabled (the default) a missing role aborts the match
    // instead of silently falling back to a plain-name intro.
    const requireRole = interaction.options?.getBoolean?.('require_role') ?? true;
    const guild = interactionGuild(interaction);
    const [pingedTeam1, pingedTeam2] = await Promise.all([
      resolveTeamPing(team1, { guild, requireRole }),
      resolveTeamPing(team2, { guild, requireRole }),
    ]);

    await interaction.deferReply({ ...eph });
    const { thread } = await createMatch({
      roundChannel,
      team1: pingedTeam1,
      team2: pingedTeam2,
      locale,
      repository,
    });
    return interaction.editReply(
      t(locale, 'match_created_success', {
        team1: team1.name,
        team2: team2.name,
        thread: `<#${thread.id}>`,
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'match-create failed');
    return replyError(interaction, locale, err);
  }
}

async function handleMatchCreateBulk(interaction) {
  const locale = interactionLocale(interaction);
  try {
    if (!isCreator(interaction)) {
      return interaction.reply({ content: t(locale, 'role_gate_denied'), ...eph });
    }
    if (!interaction.channel?.threads?.create) {
      return interaction.reply({ content: t(locale, 'round_channel_required'), ...eph });
    }

    const token = createBulkSession({
      userId: interaction.user.id,
      channelId: interaction.channel.id,
      requireRole: interaction.options?.getBoolean?.('require_role') ?? true,
    });
    const session = getBulkSession(token);
    return showBulkPanel(interaction, locale, token, session);
  } catch (err) {
    logger.warn({ err }, 'match-create-bulk failed');
    return replyError(interaction, locale, err);
  }
}

async function handleResultCommand(interaction, repository = defaultRepository) {
  const locale = interactionLocale(interaction);
  try {
    if (!isMatchAdmin(interaction)) {
      return interaction.reply({ content: t(locale, 'admin_gate_denied'), ...eph });
    }
    if (!interaction.channel?.isThread?.()) {
      return interaction.reply({ content: t(locale, 'result_outside_thread'), ...eph });
    }
    const record = await repository.findByThreadId(interaction.channel.id);
    if (!record) {
      return interaction.reply({ content: t(locale, 'result_outside_thread'), ...eph });
    }
    if (record.status === 'completed' || record.result) {
      return interaction.reply({ content: t(locale, 'result_already_completed'), ...eph });
    }

    const [team1Name, team2Name] = await Promise.all([
      resolveTeamName(interaction, record.team1Id),
      resolveTeamName(interaction, record.team2Id),
    ]);

    return interaction.reply({
      content: t(locale, 'winner_prompt', { team1: team1Name, team2: team2Name }),
      components: [buildWinnerSelect({ locale, threadId: record.threadId, team1Name, team2Name })],
      ...eph,
    });
  } catch (err) {
    logger.warn({ err }, 'result command failed');
    return replyError(interaction, locale, err);
  }
}

export async function handleMatchCommand(interaction, repository = defaultRepository) {
  switch (interaction.commandName) {
    case 'match-create':
      return handleMatchCreate(interaction, repository);
    case 'match-create-bulk':
      return handleMatchCreateBulk(interaction);
    case 'result':
      return handleResultCommand(interaction, repository);
    default:
      return undefined;
  }
}

/* ----------------------------- components ------------------------------- */

async function handleBulkComponent(interaction, sub, token) {
  const locale = interactionLocale(interaction);
  if (!isCreator(interaction)) {
    return updateError(interaction, locale, new MatchModuleError('role_gate_denied'));
  }
  const session = getBulkSession(token);
  if (!session) {
    return updateError(interaction, locale, new MatchModuleError('bulk_expired'));
  }
  if (session.userId !== interaction.user.id) {
    return interaction.reply({ content: t(locale, 'bulk_only_owner'), ...eph });
  }

  if (sub === 't1' || sub === 't2') {
    const teamId = interaction.values?.[0];
    if (!teamId) return updateError(interaction, locale, new MatchModuleError('bulk_pick_both'));
    let ref;
    try {
      ref = await resolveTeamRefById(teamId);
    } catch {
      return updateError(interaction, locale, new MatchModuleError('team_not_found', { team: teamId }));
    }
    // Enrich with ping info from the guild so the intro can ping the team.
    const enriched = await resolveTeamPing(ref, {
      guild: interactionGuild(interaction),
      requireRole: session.requireRole,
    });
    session.pending[sub === 't1' ? 'team1' : 'team2'] = enriched;
    session.notice = null;
    return updateBulkPanel(interaction, locale, token, session);
  }

  if (sub === 'add') {
    const { team1, team2 } = session.pending;
    if (!team1 || !team2) {
      session.notice = t(locale, 'bulk_pick_both');
      return updateBulkPanel(interaction, locale, token, session);
    }
    if (team1.id === team2.id) {
      session.notice = t(locale, 'bulk_pick_distinct');
      return updateBulkPanel(interaction, locale, token, session);
    }
    const duplicate = session.pairs.some(
      (pair) =>
        (pair.team1.id === team1.id && pair.team2.id === team2.id) ||
        (pair.team1.id === team2.id && pair.team2.id === team1.id),
    );
    if (duplicate) {
      session.notice = t(locale, 'bulk_duplicate_pair');
      return updateBulkPanel(interaction, locale, token, session);
    }

    session.pairs.push({ team1, team2 });
    session.pending = { team1: null, team2: null };
    session.notice = null;
    return updateBulkPanel(interaction, locale, token, session);
  }

  if (sub === 'cancel') {
    deleteBulkSession(token);
    return interaction.update({ content: t(locale, 'bulk_cancelled'), components: [] });
  }

  if (sub === 'confirm') {
    if (!session.pairs.length) {
      session.notice = t(locale, 'bulk_empty');
      return updateBulkPanel(interaction, locale, token, session);
    }
    await interaction.deferUpdate();
    const results = await createBulkMatches({
      roundChannel: interaction.channel,
      pairs: session.pairs,
      locale,
      repository: defaultRepository,
      guild: interactionGuild(interaction),
      requireRole: session.requireRole,
    });
    deleteBulkSession(token);
    return interaction.editReply({
      content: buildBulkSummary({ locale, results }),
      components: [],
    });
  }

  return undefined;
}

async function handleResultPick(interaction, threadId) {
  const locale = interactionLocale(interaction);
  if (!isMatchAdmin(interaction)) {
    return interaction.reply({ content: t(locale, 'admin_gate_denied'), ...eph });
  }
  if (!interaction.channel?.isThread?.() || interaction.channel.id !== threadId) {
    return updateError(interaction, locale, new MatchModuleError('result_outside_thread'));
  }
  const record = await defaultRepository.findByThreadId(threadId);
  if (!record) return updateError(interaction, locale, new MatchModuleError('result_outside_thread'));
  if (record.status === 'completed' || record.result) {
    return updateError(interaction, locale, new MatchModuleError('result_already_completed'));
  }

  const winner = interaction.values?.[0];
  if (winner !== 'team1' && winner !== 'team2') {
    return updateError(interaction, locale, new MatchModuleError('invalid_winner'));
  }
  const [team1Name, team2Name] = await Promise.all([
    resolveTeamName(interaction, record.team1Id),
    resolveTeamName(interaction, record.team2Id),
  ]);
  const winnerName = winner === 'team1' ? team1Name : team2Name;
  const token = createResultConfirmation({
    threadId,
    winner,
    requesterId: interaction.user.id,
    team1Name,
    team2Name,
  });

  return interaction.update({
    content: t(locale, 'result_confirm_prompt', {
      winner: winnerName,
      team1: team1Name,
      team2: team2Name,
    }),
    components: [buildResultConfirmRow({ locale, token })],
  });
}

async function handleResultConfirm(interaction, token) {
  const locale = interactionLocale(interaction);
  if (!isMatchAdmin(interaction)) {
    return interaction.reply({ content: t(locale, 'admin_gate_denied'), ...eph });
  }

  const taken = takeResultConfirmation(token, interaction.user.id);
  if (taken.error === 'forbidden') {
    return interaction.reply({ content: t(locale, 'result_only_requester'), ...eph });
  }
  if (taken.error) {
    return updateError(interaction, locale, new MatchModuleError('result_expired'));
  }

  const { entry } = taken;
  await interaction.deferUpdate();
  try {
    const { result } = await recordResult({
      threadId: entry.threadId,
      winner: entry.winner,
      decidedBy: interaction.user.id,
      repository: defaultRepository,
    });
    const winnerName = entry.winner === 'team1' ? entry.team1Name : entry.team2Name;
    const embed = buildResultEmbed({
      locale,
      team1Name: entry.team1Name,
      team2Name: entry.team2Name,
      winner: entry.winner,
      winnerName,
      decidedBy: interaction.user.id,
    });

    const thread = await interaction.client.channels.fetch(entry.threadId).catch(() => null);
    if (thread?.send) await thread.send({ embeds: [embed] }).catch(() => {});
    logger.info({ threadId: entry.threadId, winner: result.winner }, 'Match result recorded');

    return interaction.editReply({ content: t(locale, 'result_confirmed'), components: [] });
  } catch (err) {
    logger.warn({ err }, 'result confirmation failed');
    return updateError(interaction, locale, err);
  }
}

async function handleResultCancel(interaction, token) {
  const locale = interactionLocale(interaction);
  if (!isMatchAdmin(interaction)) {
    return interaction.reply({ content: t(locale, 'admin_gate_denied'), ...eph });
  }
  const entry = peekResultConfirmation(token);
  if (entry && entry.requesterId !== interaction.user.id) {
    return interaction.reply({ content: t(locale, 'result_only_requester'), ...eph });
  }
  deleteResultConfirmation(token);
  return interaction.update({ content: t(locale, 'cancel_notice'), components: [] });
}

export async function handleMatchComponent(interaction) {
  const [, scope, sub, token] = interaction.customId.split(':');
  if (scope === 'bulk') {
    try {
      return await handleBulkComponent(interaction, sub, token);
    } catch (err) {
      logger.warn({ err }, 'bulk component failed');
      return updateError(interaction, interaction.locale, err);
    }
  }

  if (scope === 'result') {
    try {
      if (sub === 'pick') return await handleResultPick(interaction, token);
      if (sub === 'confirm') return await handleResultConfirm(interaction, token);
      if (sub === 'cancel') return await handleResultCancel(interaction, token);
    } catch (err) {
      logger.warn({ err }, 'result component failed');
      return updateError(interaction, interaction.locale, err);
    }
  }

  return undefined;
}

export { isCreator, isMatchAdmin };
export default {
  handleMatchCommand,
  handleMatchComponent,
  isCreator,
  isMatchAdmin,
};
