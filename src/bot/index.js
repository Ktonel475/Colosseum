import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { handleInteraction } from './interactions/index.js';
import { registerCommands } from './registerCommands.js';
import { sendWelcome } from './welcome.js';

export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
  });
}

export function attachHandlers(client) {
  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, 'Discord bot ready');
    c.user.setActivity('competition management');

    const configuredGuild = config.discord.guildId;
    if (configuredGuild && !c.guilds.cache.has(configuredGuild)) {
      logger.error(
        {
          configuredGuild,
          availableGuilds: c.guilds.cache.map((g) => ({ id: g.id, name: g.name })),
        },
        'The bot is not a member of DISCORD_SERVER_ID. Invite it to the server and/or fix the ID.',
      );
    }

    try {
      const result = await registerCommands(c);
      logger.info(result, 'Slash commands registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }
  });

  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, { client }));

  client.on(Events.GuildMemberAdd, async (member) => {
    logger.info({ user: member.id, guild: member.guild.id }, 'Member joined');
    await sendWelcome(member);
  });

  client.on(Events.Error, (err) => logger.error({ err }, 'Discord client error'));
  client.on(Events.Warn, (msg) => logger.warn(msg));
}

export async function startBot() {
  if (!config.discord.token) {
    logger.error('DISCORD_BOT_TOKEN is not set; bot will not start');
    return null;
  }
  const client = createClient();
  attachHandlers(client);
  await client.login(config.discord.token);
  return client;
}

export default { createClient, attachHandlers, startBot };
