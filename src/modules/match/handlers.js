import { MessageFlags } from 'discord.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { createTranslator } from '../../utils/i18n.js';
import {
  MatchModuleError,
  createBulkMatches,
  createMatch,
  recordResult,
  toTeamRef,
} from './service.js';
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

async function resolveTeamName(interaction, userId) {
  const member = await interaction.guild?.members.fetch(userId).catch(() => null);
  if (member) return member.displayName;
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  return user?.displayName || user?.globalName || user?.username || String(userId);
}

/* ------------------------------ commands -------------------------------- */

async function handleMatchCreate(interaction, repository = defaultRepository) {
  const locale = interaction.locale;
  try {
    if (!isCreator(interaction)) {
      return interaction.reply({ content: t(locale, 'role_gate_denied'), ...eph });
    }
    if (!interaction.channel?.threads?.create) {
      return interaction.reply({ content: t(locale, 'round_channel_required'), ...eph });
    }

    const team1 = toTeamRef(interaction.options.getUser('team1', true));
    const team2 = toTeamRef(interaction.options.getUser('team2', true));
    if (team1.id === team2.id) {
      return interaction.reply({ content: t(locale, 'self_match_error'), ...eph });
    }

    await interaction.deferReply({ ...eph });
    const { thread } = await createMatch({
      roundChannel: interaction.channel,
      team1,
      team2,
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
  const locale = interaction.locale;
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
    });
    const session = getBulkSession(token);
    return interaction.reply({ ...buildBulkPanel({ locale, token, session }), ...eph });
  } catch (err) {
    logger.warn({ err }, 'match-create-bulk failed');
    return replyError(interaction, locale, err);
  }
}

async function handleResultCommand(interaction, repository = defaultRepository) {
  const locale = interaction.locale;
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
  const locale = interaction.locale;
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
    const userId = interaction.values?.[0];
    if (!userId) return updateError(interaction, locale, new MatchModuleError('bulk_pick_both'));
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    const ref = user ? toTeamRef(user) : { id: userId, name: String(userId) };
    session.pending[sub === 't1' ? 'team1' : 'team2'] = ref;
    session.notice = null;
    return interaction.update(buildBulkPanel({ locale, token, session }));
  }

  if (sub === 'add') {
    const { team1, team2 } = session.pending;
    if (!team1 || !team2) {
      session.notice = t(locale, 'bulk_pick_both');
      return interaction.update(buildBulkPanel({ locale, token, session }));
    }
    if (team1.id === team2.id) {
      session.notice = t(locale, 'bulk_pick_distinct');
      return interaction.update(buildBulkPanel({ locale, token, session }));
    }
    const duplicate = session.pairs.some(
      (pair) =>
        (pair.team1.id === team1.id && pair.team2.id === team2.id) ||
        (pair.team1.id === team2.id && pair.team2.id === team1.id),
    );
    if (duplicate) {
      session.notice = t(locale, 'bulk_duplicate_pair');
      return interaction.update(buildBulkPanel({ locale, token, session }));
    }

    session.pairs.push({ team1, team2 });
    session.pending = { team1: null, team2: null };
    session.notice = null;
    return interaction.update(buildBulkPanel({ locale, token, session }));
  }

  if (sub === 'cancel') {
    deleteBulkSession(token);
    return interaction.update({ content: t(locale, 'bulk_cancelled'), components: [] });
  }

  if (sub === 'confirm') {
    if (!session.pairs.length) {
      session.notice = t(locale, 'bulk_empty');
      return interaction.update(buildBulkPanel({ locale, token, session }));
    }
    await interaction.deferUpdate();
    const results = await createBulkMatches({
      roundChannel: interaction.channel,
      pairs: session.pairs,
      locale,
      repository: defaultRepository,
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
  const locale = interaction.locale;
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
  const locale = interaction.locale;
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
  const locale = interaction.locale;
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
