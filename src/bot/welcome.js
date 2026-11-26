import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import * as playerService from '../services/playerService.js';
import { getUserLocale } from '../services/languageService.js';
import { t } from '../utils/i18n.js';

/**
 * Send the newcomer DM that starts team selection.
 * Used on GuildMemberAdd and by the development `/init` command.
 *
 * Accepts either a GuildMember or a User (off-server users can still be DM'd
 * when Discord allows it) plus an explicit guild id.
 *
 * @param {object} target discord.js GuildMember or User (`id`, `send`)
 * @param {string} [guildId] guild used to scope the selection session
 * @param {object} [options]
 * @param {string} [options.locale] explicit locale (defaults to the saved user
 *   preference, then the guild locale, then English)
 * @returns {Promise<boolean>} true when the DM was delivered
 */
export async function sendWelcome(target, guildId, { locale } = {}) {
  const userId = target.id;
  const username = target.user?.username ?? target.username ?? 'Unknown';
  const sessionGuildId = guildId ?? target.guild?.id ?? null;

  try {
    await playerService.createSelectionSession({
      discordUserId: userId,
      discordUsername: username,
      guildId: sessionGuildId,
    });

    const resolvedLocale =
      locale ??
      (await getUserLocale(userId, target.guild?.preferredLocale).catch(() => null)) ??
      'en';

    const embed = new EmbedBuilder()
      .setTitle(t(resolvedLocale, 'welcome.title'))
      .setDescription(t(resolvedLocale, 'welcome.description'))
      .setColor(0x5865f2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('team:choose')
        .setLabel(t(resolvedLocale, 'welcome.choose_team'))
        .setStyle(ButtonStyle.Primary),
    );

    await target.send({ embeds: [embed], components: [row] });
    return true;
  } catch (err) {
    logger.warn({ err, user: userId }, 'Could not DM member with the welcome message');
    return false;
  }
}

export default { sendWelcome };
