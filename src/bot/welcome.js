import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import * as playerService from '../services/playerService.js';

/**
 * Send the newcomer DM that starts team selection.
 * Used on GuildMemberAdd and by the development `/init` command.
 *
 * Accepts either a GuildMember or a User (off-server users can still be DM'd
 * when Discord allows it) plus an explicit guild id.
 *
 * @param {object} target discord.js GuildMember or User (`id`, `send`)
 * @param {string} [guildId] guild used to scope the selection session
 * @returns {Promise<boolean>} true when the DM was delivered
 */
export async function sendWelcome(target, guildId) {
  const userId = target.id;
  const username = target.user?.username ?? target.username ?? 'Unknown';
  const sessionGuildId = guildId ?? target.guild?.id ?? null;

  try {
    await playerService.createSelectionSession({
      discordUserId: userId,
      discordUsername: username,
      guildId: sessionGuildId,
    });

    const embed = new EmbedBuilder()
      .setTitle('Welcome to the competition server!')
      .setDescription(
        'Please select the team you belong to.\n\n' +
          'Press the button below, then type your **team code (รหัสทีม)** or **team name** as a message. ' +
          'Your selection is only saved after you confirm it.',
      )
      .setColor(0x5865f2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('team:choose')
        .setLabel('Choose Team')
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
