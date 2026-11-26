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
import { NotFoundError, ValidationError, errorMessage } from '../../utils/errors.js';
import { tUser, interactionLocale } from '../../utils/i18n.js';
import * as languageService from '../../services/languageService.js';
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

/** Translate a bot string using the interaction's resolved user language. */
function tr(interaction, key, params) {
  return tUser(interaction, key, params);
}

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
  // Prefer the guild the interaction happened in; for DMs fall back to the
  // first guild the bot has joined (the server id is discovered at runtime,
  // no DISCORD_SERVER_ID configuration required).
  return interaction.guild ?? client.guilds.cache.first() ?? null;
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

function resultConfirmRow(interaction, resultId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`result:confirm:${resultId}`)
      .setLabel(tr(interaction, 'bot.result.confirm_button'))
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
    tr(interaction, 'bot.result.final_content', {
      team1: match.team1.team_name,
      score1: result.score1,
      score2: result.score2,
      team2: match.team2.team_name,
    });

  const embed = new EmbedBuilder()
    .setTitle(tr(interaction, 'bot.result.confirmed_title'))
    .setColor(0x2ecc71)
    .addFields(
      {
        name: tr(interaction, 'bot.result.team1_field', { team: match.team1.team_name }),
        value: String(result.score1),
        inline: true,
      },
      {
        name: tr(interaction, 'bot.result.team2_field', { team: match.team2.team_name }),
        value: String(result.score2),
        inline: true,
      },
      {
        name: tr(interaction, 'bot.result.submitted_by'),
        value: result.submitted_by
          ? `<@${result.submitted_by}>`
          : tr(interaction, 'bot.result.unknown'),
      },
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

function wideNote(interaction) {
  return tr(interaction, 'common.wide_note');
}

function adminOnly(interaction) {
  if (isAdmin(interaction)) return false;
  const message = tr(interaction, 'common.permission_denied');
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
    // Resolve the language once per interaction: saved user preference first,
    // then the Discord client locale. Every handler reads `interaction.userLocale`.
    interaction.userLocale = await languageService.resolveInteractionLocale(interaction);

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
    const payload = { content: errorMessage(interactionLocale(interaction), err), ...eph };
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

  if (
    interaction.commandName === 'match-create' &&
    (focused.name === 'team1' || focused.name === 'team2')
  ) {
    const teams = await teamService.listTeams({});
    const matches = teams
      .filter((team) =>
        `${team.team_id} ${team.team_name} ${team.game_type ?? ''}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, 25)
      .map((team) => ({
        name: `${team.team_name} (${team.team_id})${team.game_type ? ` • ${team.game_type}` : ''}`.slice(
          0,
          100,
        ),
        value: team.team_id,
      }));
    return interaction.respond(matches);
  }

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
    case 'language':
      return handleLanguage(interaction);
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
      return interaction.reply({ content: tr(interaction, 'common.command_unknown'), ...eph });
  }
}

/**
 * `/language` — persist the user's language choice. The command sets the
 * preference, then answers in the newly selected language.
 */
async function handleLanguage(interaction) {
  const requested = interaction.options.getString('language', true);
  const saved = await languageService.setUserLocale(interaction.user.id, requested);
  interaction.userLocale = saved.locale;
  return interaction.reply({
    content: tr(interaction, 'bot.language.saved', {
      language: tr(interaction, `language.${saved.locale}`),
    }),
    ...eph,
  });
}

async function handleTeamImport(interaction, ctx) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });

  const attachment = interaction.options.getAttachment('file', true);
  if (!/\.xlsx$/i.test(attachment.name)) {
    return interaction.editReply(tr(interaction, 'bot.team_import.invalid_file'));
  }
  if (attachment.size > config.maxFileSize) {
    return interaction.editReply(tr(interaction, 'bot.team_import.file_too_large'));
  }

  const res = await fetch(attachment.url);
  if (!res.ok) return interaction.editReply(tr(interaction, 'bot.team_import.download_failed'));
  const buffer = Buffer.from(await res.arrayBuffer());

  const { rows, errors } = await parseTeamWorkbook(buffer);
  const rowErrors = [...errors, ...validateTeamRows(rows)];
  if (rowErrors.length) {
    const text =
      tr(interaction, 'bot.team_import.rejected') +
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
    .setTitle(tr(interaction, 'bot.team_import.preview_title'))
    .setColor(0x2ecc71)
    .addFields(
      {
        name: tr(interaction, 'bot.team_import.valid_rows'),
        value: String(preview.counts.incoming),
        inline: true,
      },
      { name: tr(interaction, 'bot.team_import.new'), value: String(preview.counts.new), inline: true },
      {
        name: tr(interaction, 'bot.team_import.updated'),
        value: String(preview.counts.updated),
        inline: true,
      },
      {
        name: tr(interaction, 'bot.team_import.deactivated'),
        value: String(preview.counts.removed),
        inline: true,
      },
    )
    .setFooter({ text: tr(interaction, 'bot.team_import.footer') });

  const blocks = [];
  const tableHeaders = () => [
    tr(interaction, 'table.name'),
    tr(interaction, 'table.code'),
    tr(interaction, 'table.game_type'),
  ];
  const pushGroup = (label, list) => {
    if (!list.length) return;
    const rows = list.map((team) => [team.team_name, team.team_id, team.game_type ?? '-']);
    const messages = formatTableMessages(tableHeaders(), rows);
    messages.forEach((message, index) => {
      blocks.push(index === 0 ? `**${label}**\n${message}` : message);
    });
  };
  pushGroup(tr(interaction, 'bot.team_import.new'), preview.newTeams);
  pushGroup(tr(interaction, 'bot.team_import.updated'), preview.updatedTeams);
  pushGroup(tr(interaction, 'bot.team_import.deactivated'), preview.removedTeams);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`import:confirm:${token}`)
      .setLabel(tr(interaction, 'bot.team_import.confirm'))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`import:cancel:${token}`)
      .setLabel(tr(interaction, 'common.cancel'))
      .setStyle(ButtonStyle.Secondary),
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
  if (!teams.length) {
    return interaction.reply({ content: tr(interaction, 'bot.team_list.empty'), ...eph });
  }
  const rows = teams.map((team) => [team.team_name, team.team_id, team.game_type ?? '-']);
  const messages = formatTableMessages(
    [
      tr(interaction, 'table.name'),
      tr(interaction, 'table.code'),
      tr(interaction, 'table.game_type'),
    ],
    rows,
  );
  if (containsWideChars(rows.flat())) {
    messages[messages.length - 1] += `\n${wideNote(interaction)}`;
  }
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
    `${tr(interaction, 'bot.team_add.added')}\n${formatTable(
      [
        tr(interaction, 'table.name'),
        tr(interaction, 'table.code'),
        tr(interaction, 'table.game_type'),
      ],
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
    `${tr(interaction, 'bot.team_remove.removed')}\n${formatTable(
      [
        tr(interaction, 'table.name'),
        tr(interaction, 'table.code'),
        tr(interaction, 'table.game_type'),
      ],
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
    tr(interaction, 'bot.team_sync.complete', {
      synced: results.length - errors.length,
      total: results.length,
    }) +
      (errors.length
        ? `\n${tr(interaction, 'bot.team_sync.errors', {
            errors: errors.map((e) => `${e.team}`).join(', '),
          })}`
        : ''),
  );
}

async function handleMyTeam(interaction) {
  const player = await playerService.getPlayerByDiscordId(interaction.user.id);
  if (!player?.team) {
    return interaction.reply({
      content: tr(interaction, 'bot.myteam.none'),
      ...eph,
    });
  }
  const team = player.team;
  const table = formatTable(
    [
      tr(interaction, 'table.team'),
      tr(interaction, 'table.code'),
      tr(interaction, 'table.game_type'),
    ],
    [[team.team_name, team.team_id, team.game_type ?? '-']],
  );
  const note = containsWideChars([team.team_name, team.game_type])
    ? `\n${wideNote(interaction)}`
    : '';
  return interaction.reply({ content: `${tr(interaction, 'bot.myteam.title')}\n${table}${note}`, ...eph });
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
    (note ? `${note}\n\n` : '') + tr(interaction, 'bot.search.intro', { minutes });

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
        content: tr(interaction, 'bot.search.not_found', { query: query.slice(0, 100) }),
      });
      return;
    }

    collector.stop('found');
    const select = new StringSelectMenuBuilder()
      .setCustomId('team:select')
      .setPlaceholder(tr(interaction, 'bot.search.placeholder'))
      .addOptions(
        teams.slice(0, 25).map((team) => ({
          label: team.team_name.slice(0, 100),
          description: tr(interaction, 'bot.search.option_description', {
            code: team.team_id,
            game: team.game_type ?? '-',
          }).slice(0, 100),
          value: team.team_id,
        })),
      );
    await send({
      content: tr(interaction, 'bot.search.found', {
        count: teams.length,
        query: query.slice(0, 100),
      }),
      components: [
        new ActionRowBuilder().addComponents(select),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('team:search')
            .setLabel(tr(interaction, 'bot.search.again'))
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'cancelled') {
      await send({ content: tr(interaction, 'bot.search.cancelled') });
    } else if (reason === 'time') {
      await send({ content: tr(interaction, 'bot.search.expired') });
    }
  });
}

/**
 * Show the mandatory confirm/cancel step for a selected team.
 */
async function showTeamConfirmation(interaction, ctx, team, { update = false } = {}) {
  if (!team.is_active) {
    const payload = { content: tr(interaction, 'bot.team_select.inactive'), components: [] };
    return update ? interaction.update(payload) : interaction.reply({ ...payload, ...eph });
  }

  const token = createPendingSelection({
    discordUserId: interaction.user.id,
    teamId: team.team_id,
    guildId: getGuild(interaction, ctx.client)?.id ?? null,
  });
  const existing = await playerService.getPlayerByDiscordId(interaction.user.id);
  const headers = () => [
    tr(interaction, 'table.team'),
    tr(interaction, 'table.code'),
    tr(interaction, 'table.game_type'),
  ];
  const selected = formatTable(headers(), [
    [team.team_name, team.team_id, team.game_type ?? '-'],
  ]);
  const current = existing?.team
    ? `\n\n${tr(interaction, 'bot.team_select.current')}\n` +
      formatTable(headers(), [
        [existing.team.team_name, existing.team.team_id, existing.team.game_type ?? '-'],
      ])
    : '';
  const wide = containsWideChars([
    team.team_name,
    team.game_type,
    existing?.team?.team_name,
    existing?.team?.game_type,
  ]);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team:confirm:${token}`)
      .setLabel(tr(interaction, 'common.confirm'))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`team:cancel:${token}`)
      .setLabel(tr(interaction, 'common.cancel'))
      .setStyle(ButtonStyle.Secondary),
  );
  const payload = {
    content:
      `${tr(interaction, 'bot.team_select.selected')}\n${selected}${current}\n\n` +
      tr(interaction, 'bot.team_select.confirm_question') +
      (wide ? `\n${wideNote(interaction)}` : ''),
    components: [row],
  };
  return update ? interaction.update(payload) : interaction.reply({ ...payload, ...eph });
}

async function handleInit(interaction) {
  if (!config.devCommands) {
    return interaction.reply({ content: tr(interaction, 'bot.init.disabled'), ...eph });
  }

  await interaction.deferReply({ ...eph });

  // Discord's native User option: the selected user's ID is the immutable
  // identifier. Never resolve an init target from a typed name.
  const target = interaction.options.getUser('target', true);
  const guild = getGuild(interaction, interaction.client);
  const member = guild ? await guild.members.fetch(target.id).catch(() => null) : null;

  if (config.match.moduleOnly) {
    // In module-only mode, reset the player state but skip the automatic
    // newcomer welcome DM. The member can still use /regist or /repick-team.
    const result = await playerService.initializePlayer({
      discordUserId: target.id,
      discordUsername: target.username,
      actorDiscordId: interaction.user.id,
    });
    return interaction.editReply({
      content: tr(interaction, 'bot.init.module_only', {
        user: `<@${result.player.discord_user_id}>`,
        username: result.player.discord_username,
      }),
      ...eph,
    });
  }

  const result = await playerService.initializePlayer({
    discordUserId: target.id,
    discordUsername: target.username,
    actorDiscordId: interaction.user.id,
  });

  // Behave like a newcomer: resend the welcome DM with the Choose Team button.
  const dmSent = await sendWelcome(member ?? target, guild?.id);

  return interaction.editReply({
    content: tr(interaction, dmSent ? 'bot.init.dm_sent' : 'bot.init.dm_failed', {
      user: `<@${result.player.discord_user_id}>`,
      username: result.player.discord_username,
    }),
  });
}

async function handleRegister(interaction, ctx) {
  const existing = await playerService.getPlayerByDiscordId(interaction.user.id);
  if (existing?.team) {
    return interaction.reply({
      content: tr(interaction, 'bot.regist.already_registered', {
        team: existing.team.team_name,
        code: existing.team.team_id,
      }),
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
        note: tr(interaction, 'bot.search.retry_note', {
          error: errorMessage(interactionLocale(interaction), err),
        }),
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
        note: tr(interaction, 'bot.search.retry_note', {
          error: errorMessage(interactionLocale(interaction), err),
        }),
      });
    }
    throw err;
  }
  return showTeamConfirmation(interaction, ctx, team);
}

async function handleMatchList(interaction) {
  const status = interaction.options.getString('status') ?? undefined;
  const matches = await matchService.listMatches({ status });
  if (!matches.length) {
    return interaction.reply({ content: tr(interaction, 'bot.match_list.empty'), ...eph });
  }
  const rows = matches.slice(0, 50).map((match) => {
    const result = match.results?.[0];
    return [
      match.team1?.team_name ?? '?',
      result ? `${result.score1}-${result.score2}` : '-',
      match.team2?.team_name ?? '?',
      match.status,
    ];
  });
  const messages = formatTableMessages(
    [
      tr(interaction, 'table.team1'),
      tr(interaction, 'table.score'),
      tr(interaction, 'table.team2'),
      tr(interaction, 'table.status'),
    ],
    rows,
  );
  if (containsWideChars(rows.flat())) {
    messages[messages.length - 1] += `\n${wideNote(interaction)}`;
  }
  return replyMessages(interaction, messages);
}

async function handleMatchInfo(interaction, ctx) {
  let identifier = interaction.options.getString('match');
  if (!identifier && interaction.channel?.isThread?.()) identifier = interaction.channel.id;
  if (!identifier) {
    return interaction.reply({ content: tr(interaction, 'bot.match_info.missing'), ...eph });
  }
  const match = await matchService.getMatch(identifier);
  const result = match.results?.[0];
  const embed = new EmbedBuilder()
    .setTitle(`${match.team1?.team_name} vs ${match.team2?.team_name}`)
    .addFields(
      { name: tr(interaction, 'bot.match_info.match_id'), value: match.id, inline: true },
      { name: tr(interaction, 'bot.match_info.status'), value: match.status, inline: true },
      {
        name: tr(interaction, 'bot.match_info.thread'),
        value: match.discord_thread_id
          ? `<#${match.discord_thread_id}>`
          : tr(interaction, 'bot.match_info.not_available'),
        inline: true,
      },
      {
        name: tr(interaction, 'bot.match_info.result'),
        value: result
          ? `${result.score1}-${result.score2} (${result.status})`
          : tr(interaction, 'bot.match_info.no_result'),
      },
    );
  return interaction.reply({ embeds: [embed], ...eph });
}

async function handleMatchClose(interaction, ctx) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  let identifier = interaction.options.getString('match');
  if (!identifier && interaction.channel?.isThread?.()) identifier = interaction.channel.id;
  if (!identifier) return interaction.editReply(tr(interaction, 'bot.match_info.missing'));
  const guild = getGuild(interaction, ctx.client);
  const match = await matchService.closeMatch(identifier, interaction.user.id, { guild });
  const channel = guild?.channels.cache.get(config.discord.matchChannelId);
  if (channel) {
    await channel.send(tr(interaction, 'bot.match_close.announcement', { match: match.id })).catch(() => {});
  }
  // The thread is deleted by closeMatch, so this reply may fail if it was sent there.
  return interaction
    .editReply(tr(interaction, 'bot.match_close.done', { match: match.id }))
    .catch(() => {});
}

async function handleResultStatus(interaction) {
  await interaction.deferReply({ ...eph });
  if (!interaction.channel?.isThread?.()) {
    return interaction.editReply(tr(interaction, 'bot.result.outside_thread'));
  }
  const match = await matchService.findMatchByThreadId(interaction.channel.id);
  if (!match) return interaction.editReply(tr(interaction, 'bot.result.not_match_thread'));
  const result = match.results?.[0];
  if (!result) return interaction.editReply(tr(interaction, 'bot.result.no_result'));
  const detail = await resultService.describeConfirmationStatus(
    result.id,
    config.resultConfirmationPolicy,
    interactionLocale(interaction),
  );
  return interaction.editReply(
    tr(interaction, 'bot.result.status_summary', {
      team1: match.team1.team_name,
      score1: result.score1,
      score2: result.score2,
      team2: match.team2.team_name,
      status: result.status,
      detail,
    }),
  );
}

async function handleResultReview(interaction) {
  if (adminOnly(interaction)) return;
  await interaction.deferReply({ ...eph });
  const results = await resultService.listResults({ status: 'pending' });
  if (!results.length) return interaction.editReply(tr(interaction, 'bot.result.review_empty'));
  const embed = new EmbedBuilder()
    .setTitle(tr(interaction, 'bot.result.review_title'))
    .setColor(0xf1c40f);
  const rows = [];
  for (const result of results.slice(0, 5)) {
    embed.addFields({
      name: `${result.match?.team1?.team_name} ${result.score1}-${result.score2} ${result.match?.team2?.team_name}`,
      value: tr(interaction, 'bot.result.review_field', {
        id: result.id,
        user: `<@${result.submitted_by}>`,
        match: result.match_id,
      }),
    });
  }
  for (const result of results.slice(0, 5)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`result:adminconfirm:${result.id}`)
          .setLabel(
            tr(interaction, 'bot.result.finalize_button', {
              team1: result.match?.team1?.team_name,
              team2: result.match?.team2?.team_name,
            }).slice(0, 80),
          )
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`result:admincancel:${result.id}`)
          .setLabel(tr(interaction, 'common.cancel'))
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
  const updated = await resultService.editResult({
    resultId,
    score1,
    score2,
    actorDiscordId: interaction.user.id,
  });
  return interaction.editReply(
    tr(interaction, 'bot.result.edit_updated', {
      score1: updated.score1,
      score2: updated.score2,
    }),
  );
}

async function handleResultCancel(interaction) {
  await interaction.deferReply({ ...eph });
  if (!interaction.channel?.isThread?.()) {
    return interaction.editReply(tr(interaction, 'bot.result.outside_thread'));
  }
  const match = await matchService.findMatchByThreadId(interaction.channel.id);
  if (!match) return interaction.editReply(tr(interaction, 'bot.result.not_match_thread'));
  const result = match.results?.[0];
  if (!result) return interaction.editReply(tr(interaction, 'bot.result.nothing_to_cancel'));
  await resultService.cancelResult({
    resultId: result.id,
    actorDiscordId: interaction.user.id,
    isAdmin: isAdmin(interaction),
    requesterId: interaction.user.id,
  });
  return interaction.editReply(tr(interaction, 'bot.result.cancelled'));
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
      note: tr(interaction, 'bot.search.new_search_note'),
    });
  }

  if (scope === 'team' && action === 'cancel') {
    cancelPendingSelection(token, interaction.user.id);
    return interaction.update({
      content: tr(interaction, 'bot.team_select.cancel_notice'),
      components: [],
    });
  }

  if (scope === 'team' && action === 'confirm') {
    const entry = consumePendingSelection(token, interaction.user.id);
    if (!entry) {
      return interaction.update({
        content: tr(interaction, 'bot.team_select.expired'),
        components: [],
      });
    }
    if (entry.forbidden) {
      return interaction.reply({ content: tr(interaction, 'bot.team_select.other_user'), ...eph });
    }
    if (entry.duplicate) {
      return interaction.reply({ content: tr(interaction, 'bot.team_select.already_processed'), ...eph });
    }
    await interaction.deferUpdate();
    const team = await teamService.getTeam(entry.teamId);
    if (!team.is_active) {
      return interaction.editReply({
        content: tr(interaction, 'bot.team_select.inactive_no_change'),
        components: [],
      });
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
      content: tr(interaction, 'bot.team_select.success', {
        team: team.team_name,
        warning: result.warning ? `\n⚠️ ${result.warning}` : '',
      }),
      components: [],
    });
  }

  if (scope === 'import' && action === 'cancel') {
    cancelPendingImport(token, interaction.user.id);
    return interaction.update({
      content: tr(interaction, 'bot.team_import.cancelled'),
      embeds: [],
      components: [],
    });
  }

  if (scope === 'import' && action === 'confirm') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: tr(interaction, 'bot.team_import.not_allowed'), ...eph });
    }
    const entry = consumePendingImport(token, interaction.user.id);
    if (!entry) {
      return interaction.update({
        content: tr(interaction, 'bot.team_import.expired'),
        embeds: [],
        components: [],
      });
    }
    if (entry.forbidden) {
      return interaction.reply({ content: tr(interaction, 'bot.team_import.only_importer'), ...eph });
    }
    if (entry.duplicate) {
      return interaction.reply({ content: tr(interaction, 'bot.team_import.already_processed'), ...eph });
    }

    await interaction.deferUpdate();
    const applied = await teamService.applyImport(entry.rows, { actorDiscordId: interaction.user.id });
    const guild = getGuild(interaction, ctx.client);
    if (guild) await teamService.syncTeamRoles(guild, interaction.user.id);
    return interaction.editReply({
      content: tr(interaction, 'bot.team_import.complete', {
        created: applied.created.length,
        updated: applied.updated.length,
        deactivated: applied.deactivated.length,
      }),
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
      return interaction.editReply(tr(interaction, 'bot.result.confirmed_final'));
    }
    const detail = await resultService.describeConfirmationStatus(
      resultId,
      config.resultConfirmationPolicy,
      interactionLocale(interaction),
    );
    return interaction.editReply(tr(interaction, 'bot.result.confirmed_pending', { detail }));
  }

  if (scope === 'result' && action === 'adminconfirm') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: tr(interaction, 'bot.result.not_allowed_finalize'), ...eph });
    }
    await interaction.deferUpdate();
    const updated = await resultService.adminConfirmResult({
      resultId: token,
      actorDiscordId: interaction.user.id,
    });
    if (updated.status === 'final') {
      await announceFinalResult(interaction, ctx, token);
      return interaction.editReply({
        content: tr(interaction, 'bot.result.finalized', { id: token }),
        embeds: [],
        components: [],
      });
    }
    return interaction.editReply({
      content: tr(interaction, 'bot.result.still_pending', { id: token }),
      embeds: [],
      components: [],
    });
  }

  if (scope === 'result' && action === 'admincancel') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: tr(interaction, 'bot.result.not_allowed_cancel'), ...eph });
    }
    await interaction.deferUpdate();
    await resultService.cancelResult({
      resultId: token,
      actorDiscordId: interaction.user.id,
      isAdmin: true,
      requesterId: interaction.user.id,
    });
    return interaction.editReply({
      content: tr(interaction, 'bot.result.admin_cancelled', { id: token }),
      embeds: [],
      components: [],
    });
  }
}

export default { handleInteraction, isAdmin, isStaff };
