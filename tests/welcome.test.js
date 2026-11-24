import prisma from '../src/database/prisma.js';
import { sendWelcome } from '../src/bot/welcome.js';
import { resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

describe('sendWelcome', () => {
  test('DMs a User by id and creates a selection session', async () => {
    const sent = [];
    const user = {
      id: 'user-100',
      username: 'alice',
      send: async (payload) => {
        sent.push(payload);
      },
    };

    const ok = await sendWelcome(user, 'guild-100');
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds).toHaveLength(1);
    expect(sent[0].components).toHaveLength(1);

    const session = await prisma.player_selections.findFirst({
      where: { discord_user_id: 'user-100' },
    });
    expect(session.discord_username).toBe('alice');
    expect(session.guild_id).toBe('guild-100');
  });

  test('uses GuildMember user and guild ids', async () => {
    const sent = [];
    const member = {
      id: 'user-101',
      user: { username: 'bob' },
      guild: { id: 'guild-101' },
      send: async (payload) => sent.push(payload),
    };

    const ok = await sendWelcome(member);
    expect(ok).toBe(true);
    const session = await prisma.player_selections.findFirst({
      where: { discord_user_id: 'user-101' },
    });
    expect(session.guild_id).toBe('guild-101');
  });

  test('returns false when the DM cannot be delivered', async () => {
    const user = {
      id: 'user-102',
      username: 'carol',
      send: async () => {
        throw new Error('Cannot send messages to this user');
      },
    };
    await expect(sendWelcome(user, 'guild-102')).resolves.toBe(false);
  });
});
