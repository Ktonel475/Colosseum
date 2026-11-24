import { jest } from '@jest/globals';
import { commandDefinitions, registerCommands } from '../src/bot/registerCommands.js';

const expectedCount = commandDefinitions.length;

function makeGuild(id) {
  return {
    id,
    commands: { set: jest.fn().mockResolvedValue([]) },
  };
}

function makeClient(guilds = []) {
  const cache = new Map(guilds.map((guild) => [guild.id, guild]));
  return {
    guilds: {
      cache,
      fetch: jest.fn(async (id) => {
        const guild = cache.get(id);
        if (!guild) throw new Error(`Unknown guild ${id}`);
        return guild;
      }),
    },
    application: { commands: { set: jest.fn().mockResolvedValue([]) } },
  };
}

describe('registerCommands', () => {
  test('defines all required options before optional ones', () => {
    for (const command of commandDefinitions) {
      const options = command.toJSON().options ?? [];
      const firstOptional = options.findIndex((option) => !option.required);
      if (firstOptional === -1) continue;
      const requiredAfterOptional = options
        .slice(firstOptional)
        .filter((option) => option.required)
        .map((option) => option.name);
      expect({ command: command.name, requiredAfterOptional }).toEqual({
        command: command.name,
        requiredAfterOptional: [],
      });
    }
  });

  test('registers to an explicit guild (used when the bot joins)', async () => {
    const guild = makeGuild('guild-1');
    const client = makeClient([guild]);

    const result = await registerCommands(client, 'guild-1');

    expect(result).toEqual({ scope: 'guild', guildId: 'guild-1', count: expectedCount });
    expect(guild.commands.set).toHaveBeenCalledTimes(1);
    expect(guild.commands.set.mock.calls[0][0]).toHaveLength(expectedCount);
  });

  test('registers to every guild the bot is already in', async () => {
    const guild1 = makeGuild('guild-1');
    const guild2 = makeGuild('guild-2');
    const client = makeClient([guild1, guild2]);

    const result = await registerCommands(client);

    expect(result).toEqual({
      scope: 'guilds',
      guilds: ['guild-1', 'guild-2'],
      count: expectedCount,
    });
    expect(guild1.commands.set).toHaveBeenCalledTimes(1);
    expect(guild2.commands.set).toHaveBeenCalledTimes(1);
    expect(client.application.commands.set).not.toHaveBeenCalled();
  });

  test('reports guilds that could not be updated', async () => {
    const guild1 = makeGuild('guild-1');
    const guild2 = makeGuild('guild-2');
    guild2.commands.set.mockRejectedValueOnce(new Error('Missing Access'));
    const client = makeClient([guild1, guild2]);

    const result = await registerCommands(client);

    expect(result).toEqual({
      scope: 'guilds',
      guilds: ['guild-1'],
      count: expectedCount,
      failed: ['Missing Access'],
    });
  });

  test('falls back to global registration when the bot is in no guilds', async () => {
    const client = makeClient();

    const result = await registerCommands(client);

    expect(result).toEqual({ scope: 'global', count: expectedCount });
    expect(client.application.commands.set).toHaveBeenCalledTimes(1);
  });
});
