import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { t } from '../../utils/i18n.js';

export const CUSTOM_ID_PREFIX = 'matchmod';

export function isMatchComponentId(customId) {
  return String(customId ?? '').startsWith(`${CUSTOM_ID_PREFIX}:`);
}

const MAX_PANEL_PAIRS = 25;

function pairLines(locale, session) {
  if (!session.pairs.length) return t(locale, 'bulk_empty_list');
  const lines = session.pairs
    .slice(0, MAX_PANEL_PAIRS)
    .map((pair) =>
      t(locale, 'bulk_pair_line', { team1: pair.team1.name, team2: pair.team2.name }),
    );
  if (session.pairs.length > MAX_PANEL_PAIRS) {
    lines.push(`… +${session.pairs.length - MAX_PANEL_PAIRS}`);
  }
  return lines.join('\n');
}

/** Build the ephemeral bulk-creation panel with two user pickers. */
export function buildBulkPanel({ locale, token, session }) {
  const team1Select = new UserSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:bulk:t1:${token}`)
    .setPlaceholder(t(locale, 'bulk_pick_team1'))
    .setMinValues(1)
    .setMaxValues(1);
  if (session.pending.team1) team1Select.setDefaultUsers([session.pending.team1.id]);

  const team2Select = new UserSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:bulk:t2:${token}`)
    .setPlaceholder(t(locale, 'bulk_pick_team2'))
    .setMinValues(1)
    .setMaxValues(1);
  if (session.pending.team2) team2Select.setDefaultUsers([session.pending.team2.id]);

  const addButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:bulk:add:${token}`)
    .setLabel(t(locale, 'bulk_add_pair'))
    .setStyle(ButtonStyle.Primary);
  const confirmButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:bulk:confirm:${token}`)
    .setLabel(t(locale, 'bulk_confirm'))
    .setStyle(ButtonStyle.Success)
    .setDisabled(session.pairs.length === 0);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:bulk:cancel:${token}`)
    .setLabel(t(locale, 'bulk_cancel'))
    .setStyle(ButtonStyle.Secondary);

  const body = t(locale, 'bulk_panel_body', {
    channel: `<#${session.channelId}>`,
    lines: pairLines(locale, session),
  });
  const notice = session.notice ? t(locale, 'bulk_note', { note: session.notice }) : '';

  return {
    content: `**${t(locale, 'bulk_panel_title')}**\n${body}${notice}`,
    components: [
      new ActionRowBuilder().addComponents(team1Select),
      new ActionRowBuilder().addComponents(team2Select),
      new ActionRowBuilder().addComponents(addButton, confirmButton, cancelButton),
    ],
  };
}

export function buildBulkSummary({ locale, results }) {
  const lines = results.map((result) =>
    result.ok
      ? t(locale, 'bulk_line_created', {
          team1: result.pair.team1.name,
          team2: result.pair.team2.name,
          thread: `<#${result.thread.id}>`,
        })
      : t(locale, 'bulk_line_failed', {
          team1: result.pair.team1.name,
          team2: result.pair.team2.name,
          error: result.error,
        }),
  );
  const created = results.filter((result) => result.ok).length;
  return t(locale, 'bulk_summary', {
    created,
    total: results.length,
    lines: lines.join('\n'),
  });
}

/** Winner picker used by /result inside a match thread. */
export function buildWinnerSelect({ locale, threadId, team1Name, team2Name }) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:result:pick:${threadId}`)
    .setPlaceholder(
      t(locale, 'winner_prompt', { team1: team1Name, team2: team2Name }).slice(0, 150),
    )
    .addOptions(
      {
        label: t(locale, 'winner_option', { team: team1Name, number: 1 }).slice(0, 100),
        value: 'team1',
      },
      {
        label: t(locale, 'winner_option', { team: team2Name, number: 2 }).slice(0, 100),
        value: 'team2',
      },
    );
  return new ActionRowBuilder().addComponents(select);
}

export function buildResultConfirmRow({ locale, token }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:result:confirm:${token}`)
      .setLabel(t(locale, 'confirm_label'))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:result:cancel:${token}`)
      .setLabel(t(locale, 'cancel_label'))
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildResultEmbed({ locale, team1Name, team2Name, winner, winnerName, decidedBy }) {
  return new EmbedBuilder()
    .setTitle(t(locale, 'result_embed', { team1: team1Name, team2: team2Name }))
    .setColor(0x2ecc71)
    .addFields(
      {
        name: t(locale, 'result_winner_field'),
        value: t(locale, 'winner_option', {
          team: winnerName,
          number: winner === 'team1' ? 1 : 2,
        }),
      },
      {
        name: t(locale, 'result_status_field'),
        value: t(locale, 'result_status_completed'),
        inline: true,
      },
      {
        name: t(locale, 'result_decided_by_field'),
        value: `<@${decidedBy}>`,
        inline: true,
      },
    );
}

export default {
  CUSTOM_ID_PREFIX,
  isMatchComponentId,
  buildBulkPanel,
  buildBulkSummary,
  buildWinnerSelect,
  buildResultConfirmRow,
  buildResultEmbed,
};
