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
    logger.info(
      { user: c.user.tag, guilds: c.guilds.cache.map((g) => ({ id: g.id, name: g.name })) },
      'Discord bot ready',
    );
    c.user.setActivity('competition management');

    try {
      const result = await registerCommands(c);
      logger.info(result, 'Slash commands registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }
  });

  // The bot learns its server(s) automatically: whenever it joins a guild,
  // register the commands there so no DISCORD_SERVER_ID is needed in .env.
  client.on(Events.GuildCreate, async (guild) => {
    logger.info({ guild: guild.id, name: guild.name }, 'Joined guild');
    try {
      const result = await registerCommands(client, guild.id);
      logger.info(result, 'Slash commands registered for new guild');
    } catch (err) {
      logger.error({ err, guild: guild.id }, 'Failed to register slash commands for new guild');
    }
  });

  client.on(Events.GuildDelete, (guild) => {
    logger.info({ guild: guild.id, name: guild.name }, 'Left guild');
  });

  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, { client }));

  client.on(Events.GuildMemberAdd, async (member) => {
    logger.info({ user: member.id, guild: member.guild.id }, 'Member joined');
    if (config.match.moduleOnly) {
      logger.debug({ user: member.id }, 'MATCH_MODULE_ONLY is enabled; skipping newcomer welcome DM');
      return;
    }
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
