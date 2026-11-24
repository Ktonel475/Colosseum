import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import * as teamService from '../../services/teamService.js';
import * as playerService from '../../services/playerService.js';
import * as matchService from '../../services/matchService.js';
import * as resultService from '../../services/resultService.js';
import { parseTeamWorkbook, validateTeamRows } from '../../imports/excelImport.js';
import { sendWelcome } from '../welcome.js';
import { splitMessage } from '../../utils/message.js';
import { formatTable, formatTableMessages, containsWideChars } from '../../utils/table.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  matchCommandNames,
  handleMatchCommand,
  handleMatchComponent,
  isMatchComponentId,
} from '../../modules/match/index.js';
import {
  createPendingSelection,
  consumePendingSelection,
  cancelPendingSelection,
  createPendingImport,
  consumePendingImport,
  cancelPendingImport,
} from './state.js';

export function isAdmin(interaction) {
  if (!interaction.inGuild?.()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleId = config.discord.adminRoleId;
  return Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
}

export function isStaff(interaction) {
  if (isAdmin(interaction)) return true;
  const roleId = config.discord.staffRoleId;
  return Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
}

function getGuild(interaction, client) {
  return interaction.guild ?? client.guilds.cache.get(config.discord.guildId) ?? null;
}

async function resolveMember(interaction, client) {
  const guild = getGuild(interaction, client);
  if (!guild) return { guild: null, member: null };
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  return { guild, member };
}

function teamRoleMention(team) {
  if (!team) return '**team**';
  return team.discord_role_id ? `<@&${team.discord_role_id}>` : `**${team.team_name}**`;
}

function resultConfirmRow(resultId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`result:confirm:${resultId}`)
      .setLabel('Confirm result')
      .setStyle(ButtonStyle.Success),
  );
}

/**
 * Announce a finalized result in the match thread and in the public match
 * channel, pinging both team roles and the players involved.
 */
async function announceFinalResult(interaction, ctx, resultId) {
  const result = await resultService.getResultById(resultId);
  if (!result?.match) return;
  const { match } = result;

  const userPings = [
    ...new Set([
      result.submitted_by,
      ...(result.confirmations ?? []).map((c) => c.discord_user_id),
    ]),
  ]
    .filter(Boolean)
    .map((id) => `<@${id}>`)
    .join(' ');

  const content =
    `${teamRoleMention(match.team1)} ${teamRoleMention(match.team2)}` +
    `${userPings ? ` ${userPings}` : ''}\n` +
    `**Final result:** ${match.team1.team_name} **${result.score1} - ${result.score2}** ${match.team2.team_name}`;

  const embed = new EmbedBuilder()
    .setTitle('Result confirmed')
    .setColor(0x2ecc71)
    .addFields(
      { name: `Team 1 — ${match.team1.team_name}`, value: String(result.score1), inline: true },
      { name: `Team 2 — ${match.team2.team_name}`, value: String(result.score2), inline: true },
      { name: 'Submitted by', value: result.submitted_by ? `<@${result.submitted_by}>` : 'Unknown' },
    );

  const payload = { content, embeds: [embed] };
  const guild = getGuild(interaction, ctx.client);

  const thread = interaction.channel?.isThread?.()
    ? interaction.channel
    : match.discord_thread_id && guild
      ? await guild.channels.fetch(match.discord_thread_id).catch(() => null)
      : null;
  if (thread) await thread.send(payload).catch(() => {});

  const channel = guild?.channels.cache.get(config.discord.matchChannelId);
  if (channel && (!thread || channel.id !== thread.id)) {
    await channel.send(payload).catch(() => {});
  }
}

const eph = { flags: MessageFlags.Ephemeral };

/**
 * Send content, splitting it across several messages when it exceeds Discord's
 * 2000-character limit. Works for deferred and fresh interactions.
 */
async function replyChunked(interaction, content, { embedTitle, ephemeral = true } = {}) {
  const extra = ephemeral ? eph : {};
  const chunks = splitMessage(content);
  if (!chunks.length) return;
  const build = (text, title) =>
    title
      ? { embeds: [new EmbedBuilder().setTitle(title).setDescription(text)], ...extra }
      : { content: text, ...extra };

  if (interaction.deferred || interaction.replied) {
    const first = build(chunks[0], embedTitle);
    await interaction.editReply(embedTitle ? { embeds: first.embeds } : { content: first.content }).catch(() => {});
  } else {
    await interaction.reply(build(chunks[0], embedTitle)).catch(() => {});
  }

  for (const [index, chunk] of chunks.slice(1).entries()) {
    await interaction
      .followUp(build(chunk, embedTitle ? `${embedTitle} (${index + 2}/${chunks.length})` : undefined))
      .catch(() => {});
  }
}

/** Send a list of already-formatted message bodies (e.g. fenced tables). */
async function replyMessages(interaction, messages, { ephemeral = true } = {}) {
  const list = messages.filter(Boolean);
  if (!list.length) return;
  const extra = ephemeral ? eph : {};
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: list[0] }).catch(() => {});
  } else {
    await interaction.reply({ content: list[0], ...extra }).catch(() => {});
  }
  for (const message of list.slice(1)) {
    await interaction.followUp({ content: message, ...extra }).catch(() => {});
  }
}

const WIDE_NOTE = 'Note: Thai/CJK/emoji widths may make columns drift slightly; short labels align best.';

function adminOnly(interaction) {
  if (isAdmin(interaction)) return false;
  const message = 'You do not have permission to use this command.';
  if (interaction.deferred || interaction.replied) {
    interaction.editReply({ content: message }).catch(() => {});
  } else {
    interaction.reply({ content: message, ...eph }).catch(() => {});
  }
  return true;
}

/* ------------------------------ interaction router ----------------------- */

export async function handleInteraction(interaction, ctx) {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) {
      if (matchCommandNames.has(interaction.commandName)) {
        return await handleMatchCommand(interaction);
      }
      return await handleCommand(interaction, ctx);
    }
    if (
      (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isUserSelectMenu?.()) &&
      isMatchComponentId(interaction.customId)
    ) {
      return await handleMatchComponent(interaction);
    }
    if (interaction.isStringSelectMenu()) return await handleSelect(interaction, ctx);
    if (interaction.isButton()) return await handleButton(interaction, ctx);
  } catch (err) {
    logger.error({ err, type: interaction.type }, 'Interaction handler error');
    const payload = { content: err.message || 'An unexpected error occurred.', ...eph };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}

/* ------------------------------ autocomplete ----------------------------- */

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? '').toLowerCase();

  if (interaction.commandName === 'regist' || interaction.commandName === 'repick-team') {
    const teams = await teamService.listTeams({});
    const matches = teams
      .filter((t) => `${t.team_id} ${t.team_name} ${t.game_type ?? ''}`.toLowerCase().includes(query))
      .slice(0, 25)
      .map((t) => ({
        name: `${t.team_name} (${t.team_id})${t.game_type ? ` • ${t.game_type}` : ''}`.slice(0, 100),
        value: t.team_id,
      }));
    return interaction.respond(matches);
  }

  if (interaction.commandName === 'team-remove') {
    const teams = await teamService.listTeams({});
    const matches = teams
      .filter((t) => `${t.team_id} ${t.team_name}`.toLowerCase().includes(query))
      .slice(0, 25)
      .map((t) => ({ name: `${t.team_name} (${t.team_id})`, value: t.team_id }));
    return interaction.respond(matches);
  }

  if (interaction.commandName === 'match-info' || interaction.commandName === 'match-close') {
    const matches = await matchService.listMatches({});
    return interaction.respond(
      matches
        .filter((m) => `${m.id} ${m.team1?.team_name} ${m.team2?.team_name}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((m) => ({ name: `${m.team1?.team_name} vs ${m.team2?.team_name}`.slice(0, 100), value: m.id })),
    );
  }

  if (interaction.commandName === 'result-edit') {
    const results = await resultService.listResults({});
    return interaction.respond(
      results
        .slice(0, 25)
        .map((r) => ({
          name: `${r.match?.team1?.team_name ?? '?'} ${r.score1}-${r.score2} ${r.match?.team2?.team_name ?? '?'} (${r.status})`,
          value: r.id,
        })),
    );
  }

  return interaction.respond([]);
}

/* ------------------------------ slash commands --------------------------- */

async function handleCommand(interaction, ctx) {
  switch (interaction.commandName) {
    case 'team-import':
      return handleTeamImport(interaction, ctx);
    case 'team-list':
      return handleTeamList(interaction);
    case 'team-add':
      return handleTeamAdd(interaction, ctx);
    case 'team-remove':
      return handleTeamRemove(interaction);
    case 'team-sync':
      return handleTeamSync(interaction, ctx);
    case 'myteam':
      return handleMyTeam(interaction);
    case 'init':
      return handleInit(interaction);
    case 'regist':
      return handleRegister(interaction, ctx);
    case 'repick-team':
      return handleRepickTeam(interaction, ctx);
    case 'match-list':
      return handleMatchList(interaction);
    case 'match-info':
      return handleMatchInfo(interaction, ctx);
    case 'match-close':
      return handleMatchClose(interaction, ctx);
    case 'result-status':
      return handleResultStatus(interaction);
    case 'result-review':
      return handleResultReview(interaction);
    case 'result-edit':
      return handleResultEdit(interaction);
    case 'result-cancel':
      return handleResultCancel(interaction, ctx);
    default:
      return interaction.reply({ content: 'Unknown command.', ...eph });
  }
}

async function handleTeamImport(interaction, ctx) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });

  const attachment = interaction.options.getAttachment('file', true);
  if (!/\.xlsx$/i.test(attachment.name)) {
    return interaction.editReply('Please upload a valid .xlsx file.');
  }
  if (attachment.size > config.maxFileSize) {
    return interaction.editReply('File is too large.');
  }

  const res = await fetch(attachment.url);
  if (!res.ok) return interaction.editReply('Could not download the uploaded file.');
  const buffer = Buffer.from(await res.arrayBuffer());

  const { rows, errors } = await parseTeamWorkbook(buffer);
  const rowErrors = [...errors, ...validateTeamRows(rows)];
  if (rowErrors.length) {
    const text =
      'Import rejected:\n' +
      rowErrors
        .slice(0, 50)
        .map((e) => `• ${e}`)
        .join('\n');
    return replyChunked(interaction, text);
  }

  const preview = await teamService.previewImport(rows);
  const token = createPendingImport({
    rows,
    preview,
    actorDiscordId: interaction.user.id,
  });

  const embed = new EmbedBuilder()
    .setTitle('Team import preview')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Valid rows', value: String(preview.counts.incoming), inline: true },
      { name: 'New', value: String(preview.counts.new), inline: true },
      { name: 'Updated', value: String(preview.counts.updated), inline: true },
      { name: 'Deactivated', value: String(preview.counts.removed), inline: true },
    )
    .setFooter({ text: 'Confirm within 5 minutes. Deactivation keeps historical data.' });

  const blocks = [];
  const pushGroup = (label, list) => {
    if (!list.length) return;
    const rows = list.map((t) => [t.team_name, t.team_id, t.game_type ?? '-']);
    const messages = formatTableMessages(['Name', 'Code', 'Game type'], rows);
    messages.forEach((message, index) => {
      blocks.push(index === 0 ? `**${label}**\n${message}` : message);
    });
  };
  pushGroup('New', preview.newTeams);
  pushGroup('Updated', preview.updatedTeams);
  pushGroup('Deactivated', preview.removedTeams);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`import:confirm:${token}`).setLabel('Confirm import').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`import:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const [firstBlock, ...restBlocks] = blocks;
  await interaction.editReply({
    embeds: [embed],
    content: firstBlock,
    components: [row],
  });
  for (const block of restBlocks) {
    await interaction.followUp({ content: block, ...eph }).catch(() => {});
  }
}

async function handleTeamList(interaction) {
  const teams = await teamService.listTeams({});
  if (!teams.length) return interaction.reply({ content: 'No active teams.', ...eph });
  const rows = teams.map((t) => [t.team_name, t.team_id, t.game_type ?? '-']);
  const messages = formatTableMessages(['Name', 'Code', 'Game type'], rows);
  if (containsWideChars(rows.flat())) messages[messages.length - 1] += `\n${WIDE_NOTE}`;
  return replyMessages(interaction, messages);
}

async function handleTeamAdd(interaction) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const teamId = interaction.options.getString('team_id', true);
  const teamName = interaction.options.getString('team_name', true);
  const gameType = interaction.options.getString('game_type');
  const team = await teamService.addTeam(
    { team_id: teamId, team_name: teamName, game_type: gameType },
    interaction.user.id,
  );
  const { guild } = await resolveMember(interaction, interaction.client);
  if (guild) await teamService.ensureTeamRole(guild, team, interaction.user.id);
  return interaction.editReply(
    `Team added.\n${formatTable(
      ['Name', 'Code', 'Game type'],
      [[team.team_name, team.team_id, team.game_type ?? '-']],
    )}`,
  );
}

async function handleTeamRemove(interaction) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const identifier = interaction.options.getString('team', true);
  const team = await teamService.deactivateTeam(identifier, interaction.user.id);
  return interaction.editReply(
    `Team deactivated (historical data retained).\n${formatTable(
      ['Name', 'Code', 'Game type'],
      [[team.team_name, team.team_id, team.game_type ?? '-']],
    )}`,
  );
}

async function handleTeamSync(interaction, ctx) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const guild = getGuild(interaction, ctx.client);
  const results = await teamService.syncTeamRoles(guild, interaction.user.id);
  const errors = results.filter((r) => r.action === 'error');
  return interaction.editReply(
    `Role sync complete: ${results.length - errors.length}/${results.length} teams synchronized.` +
      (errors.length ? `\nErrors: ${errors.map((e) => `${e.team}`).join(', ')}` : ''),
  );
}

async function handleMyTeam(interaction) {
  const player = await playerService.getPlayerByDiscordId(interaction.user.id);
  if (!player?.team) {
    return interaction.reply({
      content: 'You have not selected a team yet. Use `/regist` or `/repick-team` to choose one.',
      ...eph,
    });
  }
  const team = player.team;
  const table = formatTable(
    ['Team', 'Code', 'Game type'],
    [[team.team_name, team.team_id, team.game_type ?? '-']],
  );
  const note = containsWideChars([team.team_name, team.game_type]) ? `\n${WIDE_NOTE}` : '';
  return interaction.reply({ content: `Your team\n${table}${note}`, ...eph });
}

/**
 * Team search without a modal: the bot asks the user to type a team code or
 * name as a normal message, then replies with a select menu. Time-limited by
 * INTERACTION_EXPIRATION (default 5 minutes).
 */
async function promptTeamSearch(interaction, ctx, { update = false, note = null } = {}) {
  const ephemeral = Boolean(interaction.inGuild?.());
  const minutes = Math.max(1, Math.round(config.interactionExpiration / 60000));

  const intro =
    (note ? `${note}\n\n` : '') +
    'Type your **team code (รหัสทีม)** or **team name** as a message in this chat.\n' +
    `You have ${minutes} minute(s). Type \`cancel\` to stop.`;

  if (update) {
    await interaction.update({ content: intro, components: [] });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: intro, ...(ephemeral ? eph : {}) });
  } else {
    await interaction.reply({ content: intro, ...(ephemeral ? eph : {}) });
  }

  const channel = interaction.channel;
  if (!channel?.createMessageCollector) return;

  const send = (payload) =>
    interaction.followUp({ ...payload, ...(ephemeral ? eph : {}) }).catch(() => {});

  const collector = channel.createMessageCollector({
    filter: (m) => !m.author.bot && m.author.id === interaction.user.id,
    time: config.interactionExpiration,
  });

  collector.on('collect', async (message) => {
    const query = String(message.content ?? '').trim();
    if (!query) return;
    if (/^cancel$/i.test(query)) {
      collector.stop('cancelled');
      return;
    }

    const teams = await playerService.searchActiveTeams(query);
    if (!teams.length) {
      await send({
        content:
          `No teams matched "${query.slice(0, 100)}". ` +
          'Try another team code or name, or type `cancel`.',
      });
      return;
    }

    collector.stop('found');
    const select = new StringSelectMenuBuilder()
      .setCustomId('team:select')
      .setPlaceholder('Select your team')
      .addOptions(
        teams.slice(0, 25).map((t) => ({
          label: t.team_name.slice(0, 100),
          description: `รหัสทีม/Code: ${t.team_id} • ประเภทเกม/Game: ${t.game_type ?? '-'}`.slice(0, 100),
          value: t.team_id,
        })),
      );
    await send({
      content: `Found ${teams.length} team(s) matching "${query.slice(0, 100)}". Select yours:`,
      components: [
        new ActionRowBuilder().addComponents(select),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('team:search')
            .setLabel('Search again')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'cancelled') {
      await send({ content: 'Team search cancelled. Nothing was changed.' });
    } else if (reason === 'time') {
      await send({
        content: 'Team search expired. Use `/repick-team` or press **Choose Team** again.',
      });
    }
  });
}

/**
 * Show the mandatory confirm/cancel step for a selected team.
 */
async function showTeamConfirmation(interaction, ctx, team, { update = false } = {}) {
  if (!team.is_active) {
    const payload = { content: 'That team is no longer active.', components: [] };
    return update ? interaction.update(payload) : interaction.reply({ ...payload, ...eph });
  }

  const token = createPendingSelection({
    discordUserId: interaction.user.id,
    teamId: team.team_id,
    guildId: getGuild(interaction, ctx.client)?.id ?? null,
  });
  const existing = await playerService.getPlayerByDiscordId(interaction.user.id);
  const selected = formatTable(
    ['Team', 'Code', 'Game type'],
    [[team.team_name, team.team_id, team.game_type ?? '-']],
  );
  const current = existing?.team
    ? '\n\nCurrent team\n' +
      formatTable(
        ['Team', 'Code', 'Game type'],
        [[existing.team.team_name, existing.team.team_id, existing.team.game_type ?? '-']],
      )
    : '';
  const wide = containsWideChars([
    team.team_name,
    team.game_type,
    existing?.team?.team_name,
    existing?.team?.game_type,
  ]);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`team:confirm:${token}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`team:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const payload = {
    content:
      `You selected\n${selected}${current}\n\n` +
      'Are you sure this is your team? (Expires in 5 minutes)' +
      (wide ? `\n${WIDE_NOTE}` : ''),
    components: [row],
  };
  return update ? interaction.update(payload) : interaction.reply({ ...payload, ...eph });
}

async function handleInit(interaction) {
  if (!config.devCommands) {
    return interaction.reply({ content: 'Development commands are disabled.', ...eph });
  }

  await interaction.deferReply({ ...eph });

  // Discord's native User option: the selected user's ID is the immutable
  // identifier. Never resolve an init target from a typed name.
  const target = interaction.options.getUser('target', true);
  const guild = getGuild(interaction, interaction.client);
  const member = guild ? await guild.members.fetch(target.id).catch(() => null) : null;

  const result = await playerService.initializePlayer({
    discordUserId: target.id,
    discordUsername: target.username,
    actorDiscordId: interaction.user.id,
  });

  // Behave like a newcomer: resend the welcome DM with the Choose Team button.
  const dmSent = await sendWelcome(member ?? target, guild?.id);

  return interaction.editReply({
    content:
      `Initialized <@${result.player.discord_user_id}> (**${result.player.discord_username}**) ` +
      'to the initial player state (no team).\n' +
      (dmSent
        ? 'The newcomer welcome DM was sent — press **Choose Team** there to pick a team.'
        : 'Could not send the welcome DM (DMs may be closed). The target must use `/regist`.'),
  });
}

async function handleRegister(interaction, ctx) {
  const existing = await playerService.getPlayerByDiscordId(interaction.user.id);
  if (existing?.team) {
    return interaction.reply({
      content:
        `You are already registered on **${existing.team.team_name}** ` +
        `(${existing.team.team_id}). Use \`/repick-team\` to change teams.`,
      ...eph,
    });
  }
  const query = interaction.options.getString('teamname');
  if (!query || !query.trim()) return promptTeamSearch(interaction, ctx);
  let team;
  try {
    team = await teamService.getTeam(query.trim());
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) {
      return promptTeamSearch(interaction, ctx, {
        note: `${err.message} Let's search again.`,
      });
    }
    throw err;
  }
  return showTeamConfirmation(interaction, ctx, team);
}

async function handleRepickTeam(interaction, ctx) {
  const query = interaction.options.getString('teamname');
  if (!query || !query.trim()) return promptTeamSearch(interaction, ctx);
  let team;
  try {
    team = await teamService.getTeam(query.trim());
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) {
      return promptTeamSearch(interaction, ctx, {
        note: `${err.message} Let's search again.`,
      });
    }
    throw err;
  }
  return showTeamConfirmation(interaction, ctx, team);
}

async function handleMatchList(interaction) {
  const status = interaction.options.getString('status') ?? undefined;
  const matches = await matchService.listMatches({ status });
  if (!matches.length) return interaction.reply({ content: 'No matches found.', ...eph });
  const rows = matches.slice(0, 50).map((m) => {
    const r = m.results?.[0];
    return [
      m.team1?.team_name ?? '?',
      r ? `${r.score1}-${r.score2}` : '-',
      m.team2?.team_name ?? '?',
      m.status,
    ];
  });
  const messages = formatTableMessages(['Team 1', 'Score', 'Team 2', 'Status'], rows);
  if (containsWideChars(rows.flat())) messages[messages.length - 1] += `\n${WIDE_NOTE}`;
  return replyMessages(interaction, messages);
}

async function handleMatchInfo(interaction, ctx) {
  let identifier = interaction.options.getString('match');
  if (!identifier && interaction.channel?.isThread?.()) identifier = interaction.channel.id;
  if (!identifier) return interaction.reply({ content: 'Provide a match ID or run this inside a match thread.', ...eph });
  const match = await matchService.getMatch(identifier);
  const result = match.results?.[0];
  const embed = new EmbedBuilder()
    .setTitle(`${match.team1?.team_name} vs ${match.team2?.team_name}`)
    .addFields(
      { name: 'Match ID', value: match.id, inline: true },
      { name: 'Status', value: match.status, inline: true },
      { name: 'Thread', value: match.discord_thread_id ? `<#${match.discord_thread_id}>` : 'n/a', inline: true },
      { name: 'Result', value: result ? `${result.score1}-${result.score2} (${result.status})` : 'No result yet' },
    );
  return interaction.reply({ embeds: [embed], ...eph });
}

async function handleMatchClose(interaction, ctx) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  let identifier = interaction.options.getString('match');
  if (!identifier && interaction.channel?.isThread?.()) identifier = interaction.channel.id;
  if (!identifier) return interaction.editReply('Provide a match ID or run this inside a match thread.');
  const guild = getGuild(interaction, ctx.client);
  const match = await matchService.closeMatch(identifier, interaction.user.id, { guild });
  const channel = guild?.channels.cache.get(config.discord.matchChannelId);
  if (channel) {
    await channel
      .send(`Match \`${match.id}\` closed. Its private thread has been removed.`)
      .catch(() => {});
  }
  // The thread is deleted by closeMatch, so this reply may fail if it was sent there.
  return interaction.editReply(`Match ${match.id} closed and thread removed.`).catch(() => {});
}

async function handleResultStatus(interaction) {
  await interaction.deferReply({ ...eph });
  if (!interaction.channel?.isThread?.()) return interaction.editReply('Use this inside a match thread.');
  const match = await matchService.findMatchByThreadId(interaction.channel.id);
  if (!match) return interaction.editReply('This thread is not a match thread.');
  const result = match.results?.[0];
  if (!result) return interaction.editReply('No result submitted yet.');
  const detail = await resultService.describeConfirmationStatus(result.id);
  return interaction.editReply(
    `**${match.team1.team_name} ${result.score1}-${result.score2} ${match.team2.team_name}**\n` +
      `Status: **${result.status}**\n${detail}`,
  );
}

async function handleResultReview(interaction) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const results = await resultService.listResults({ status: 'pending' });
  if (!results.length) return interaction.editReply('No pending results.');
  const embed = new EmbedBuilder().setTitle('Pending results').setColor(0xf1c40f);
  const rows = [];
  for (const r of results.slice(0, 5)) {
    embed.addFields({
      name: `${r.match?.team1?.team_name} ${r.score1}-${r.score2} ${r.match?.team2?.team_name}`,
      value: `Result \`${r.id}\`\nSubmitted by <@${r.submitted_by}>\nMatch \`${r.match_id}\``,
    });
  }
  for (const r of results.slice(0, 5)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`result:adminconfirm:${r.id}`)
          .setLabel(`Finalize ${r.match?.team1?.team_name} vs ${r.match?.team2?.team_name}`.slice(0, 80))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`result:admincancel:${r.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return interaction.editReply({ embeds: [embed], components: rows });
}

async function handleResultEdit(interaction) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const resultId = interaction.options.getString('result_id', true);
  const score1 = interaction.options.getInteger('score1', true);
  const score2 = interaction.options.getInteger('score2', true);
  const updated = await resultService.editResult({ resultId, score1, score2, actorDiscordId: interaction.user.id });
  return interaction.editReply(`Result updated to ${updated.score1}-${updated.score2}.`);
}

async function handleResultCancel(interaction) {
  await interaction.deferReply({ ...eph });
  if (!interaction.channel?.isThread?.()) return interaction.editReply('Use this inside a match thread.');
  const match = await matchService.findMatchByThreadId(interaction.channel.id);
  if (!match) return interaction.editReply('This thread is not a match thread.');
  const result = match.results?.[0];
  if (!result) return interaction.editReply('No result to cancel.');
  await resultService.cancelResult({
    resultId: result.id,
    actorDiscordId: interaction.user.id,
    isAdmin: isAdmin(interaction),
    requesterId: interaction.user.id,
  });
  return interaction.editReply('Result cancelled.');
}

/* ------------------------------ select menus ----------------------------- */

async function handleSelect(interaction, ctx) {
  if (interaction.customId === 'team:select') {
    const team = await teamService.getTeam(interaction.values[0]);
    return showTeamConfirmation(interaction, ctx, team, { update: true });
  }
}

/* ------------------------------ buttons ---------------------------------- */

async function handleButton(interaction, ctx) {
  const [scope, action, token] = interaction.customId.split(':');

  if (scope === 'team' && action === 'choose') {
    return promptTeamSearch(interaction, ctx);
  }

  if (scope === 'team' && action === 'search') {
    // Reverting a mistyped search from the team picker: discard any pending
    // selection and replace the picker with a fresh prompt.
    if (token) cancelPendingSelection(token, interaction.user.id);
    return promptTeamSearch(interaction, ctx, {
      update: true,
      note: 'Starting a new search — the previous results were discarded.',
    });
  }

  if (scope === 'team' && action === 'cancel') {
    cancelPendingSelection(token, interaction.user.id);
    return interaction.update({ content: 'Team selection cancelled. Nothing was changed.', components: [] });
  }

  if (scope === 'team' && action === 'confirm') {
    const entry = consumePendingSelection(token, interaction.user.id);
    if (!entry) {
      return interaction.update({ content: 'This confirmation has expired or already been used.', components: [] });
    }
    if (entry.forbidden) {
      return interaction.reply({ content: 'This confirmation belongs to another user.', ...eph });
    }
    if (entry.duplicate) {
      return interaction.reply({ content: 'This confirmation was already processed.', ...eph });
    }
    await interaction.deferUpdate();
    const team = await teamService.getTeam(entry.teamId);
    if (!team.is_active) {
      return interaction.editReply({ content: 'That team is no longer active. Nothing was changed.', components: [] });
    }
    const { guild, member } = await resolveMember(interaction, ctx.client);
    const result = await playerService.assignTeam({
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      teamId: team.team_id,
      guild,
      member,
    });
    try {
      await matchService.syncThreadAccessForPlayer({
        guild,
        discordUserId: interaction.user.id,
        previousTeamId: result.previousTeamId,
        newTeamId: team.team_id,
      });
    } catch (err) {
      logger.warn({ err }, 'Thread access sync failed');
    }
    return interaction.editReply({
      content: `You are now on team **${team.team_name}**.${result.warning ? `\n⚠️ ${result.warning}` : ''}`,
      components: [],
    });
  }

  if (scope === 'import' && action === 'cancel') {
    cancelPendingImport(token, interaction.user.id);
    return interaction.update({ content: 'Import cancelled. No changes were made.', embeds: [], components: [] });
  }

  if (scope === 'import' && action === 'confirm') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'You do not have permission to confirm this import.', ...eph });
    }
    const entry = consumePendingImport(token, interaction.user.id);
    if (!entry) {
      return interaction.update({ content: 'This import confirmation has expired.', embeds: [], components: [] });
    }
    if (entry.forbidden) return interaction.reply({ content: 'Only the importer can confirm.', ...eph });
    if (entry.duplicate) return interaction.reply({ content: 'Already processed.', ...eph });

    await interaction.deferUpdate();
    const applied = await teamService.applyImport(entry.rows, { actorDiscordId: interaction.user.id });
    const guild = getGuild(interaction, ctx.client);
    if (guild) await teamService.syncTeamRoles(guild, interaction.user.id);
    return interaction.editReply({
      content:
        `Import complete. Created ${applied.created.length}, updated ${applied.updated.length}, ` +
        `deactivated ${applied.deactivated.length}. Discord roles synchronized.`,
      embeds: [],
      components: [],
    });
  }

  if (scope === 'result' && action === 'confirm') {
    const resultId = token;
    await interaction.deferReply({ ...eph });
    const updated = await resultService.confirmResult({ resultId, discordUserId: interaction.user.id });
    if (updated.status === 'final') {
      await announceFinalResult(interaction, ctx, resultId);
      return interaction.editReply(
        'Confirmation recorded. The result is now final and has been announced.',
      );
    }
    const detail = await resultService.describeConfirmationStatus(resultId);
    return interaction.editReply(`Confirmation recorded. ${detail}`);
  }

  if (scope === 'result' && action === 'adminconfirm') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: 'You do not have permission to finalize results.', ...eph });
    }
    await interaction.deferUpdate();
    const updated = await resultService.adminConfirmResult({
      resultId: token,
      actorDiscordId: interaction.user.id,
    });
    if (updated.status === 'final') {
      await announceFinalResult(interaction, ctx, token);
      return interaction.editReply({
        content: `Result ${token} finalized and announced.`,
        embeds: [],
        components: [],
      });
    }
    return interaction.editReply({
      content: `Result ${token} still awaits both-team confirmation.`,
      embeds: [],
      components: [],
    });
  }

  if (scope === 'result' && action === 'admincancel') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: 'You do not have permission to cancel results.', ...eph });
    }
    await interaction.deferUpdate();
    await resultService.cancelResult({
      resultId: token,
      actorDiscordId: interaction.user.id,
      isAdmin: true,
      requesterId: interaction.user.id,
    });
    return interaction.editReply({ content: `Result ${token} cancelled.`, embeds: [], components: [] });
  }
}

export default { handleInteraction, isAdmin, isStaff };
