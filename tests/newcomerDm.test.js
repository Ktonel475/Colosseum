import { jest } from '@jest/globals';
import { Events } from 'discord.js';
import prisma from '../src/database/prisma.js';
import config from '../src/config/index.js';
import { attachHandlers } from '../src/bot/index.js';
import { resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

function makeClient() {
  const handlers = new Map();
  const add = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
  };
  return {
    once: jest.fn(add),
    on: jest.fn(add),
    handlers,
  };
}

function makeMember(id) {
  const send = jest.fn();
  return {
    member: {
      id,
      user: { username: 'alice' },
      guild: { id: 'guild-1' },
      send,
    },
    send,
  };
}

describe('newcomer welcome DM', () => {
  const original = config.match.moduleOnly;

  afterEach(() => {
    config.match.moduleOnly = original;
  });

  test('is skipped when MATCH_MODULE_ONLY is enabled', async () => {
    config.match.moduleOnly = true;
    const client = makeClient();
    attachHandlers(client);

    const { member, send } = makeMember('user-module-only');
    const handler = client.handlers.get(Events.GuildMemberAdd)[0];
    await handler(member);

    expect(send).not.toHaveBeenCalled();
    const session = await prisma.player_selections.findFirst({
      where: { discord_user_id: 'user-module-only' },
    });
    expect(session).toBeNull();
  });

  test('is sent when MATCH_MODULE_ONLY is disabled', async () => {
    config.match.moduleOnly = false;
    const client = makeClient();
    attachHandlers(client);

    const { member, send } = makeMember('user-normal');
    const handler = client.handlers.get(Events.GuildMemberAdd)[0];
    await handler(member);

    expect(send).toHaveBeenCalledTimes(1);
    const session = await prisma.player_selections.findFirst({
      where: { discord_user_id: 'user-normal' },
    });
    expect(session?.guild_id).toBe('guild-1');
  });
});
