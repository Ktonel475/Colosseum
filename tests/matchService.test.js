import prisma from '../src/database/prisma.js';
import * as matchService from '../src/services/matchService.js';
import * as playerService from '../src/services/playerService.js';
import { resetDb, seedTeams, makeGuild, makeMember, makeParentChannel } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

async function setupParticipants() {
  const { alpha, bravo } = await seedTeams();
  const guild = makeGuild();
  const memberAlpha = makeMember('user-alpha', guild, []);
  const memberBravo = makeMember('user-bravo', guild, []);
  guild.__addMember(memberAlpha);
  guild.__addMember(memberBravo);
  await playerService.assignTeam({
    discordUserId: 'user-alpha',
    discordUsername: 'alpha-player',
    teamId: alpha.team_id,
  });
  await playerService.assignTeam({
    discordUserId: 'user-bravo',
    discordUsername: 'bravo-player',
    teamId: bravo.team_id,
  });
  return { alpha, bravo, guild, memberAlpha, memberBravo };
}

describe('match service', () => {
  test('creates a private thread and adds both teams', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    const parent = makeParentChannel({ threadId: 'thread-1' });
    guild.__channels.set('thread-1', parent.thread);

    const { match, thread, warnings } = await matchService.createMatch({
      team1Identifier: alpha.team_id,
      team2Identifier: bravo.team_id,
      guild,
      parentChannel: parent,
      actorDiscordId: 'admin',
    });

    expect(thread.id).toBe('thread-1');
    expect(match.discord_thread_id).toBe('thread-1');
    expect(warnings).toEqual([]);
    expect(thread.memberIds.has('user-alpha')).toBe(true);
    expect(thread.memberIds.has('user-bravo')).toBe(true);

    const found = await matchService.findMatchByThreadId('thread-1');
    expect(found.id).toBe(match.id);

    const intro = thread.messages[0];
    expect(intro).toContain('**Team 1:** Team Alpha');
    expect(intro).toContain('**Team 2:** Team Bravo');
    expect(intro).toContain('/result score1:');
  });

  test('thread intro pings both team roles', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    await prisma.teams.update({ where: { team_id: alpha.team_id }, data: { discord_role_id: 'role-alpha' } });
    await prisma.teams.update({ where: { team_id: bravo.team_id }, data: { discord_role_id: 'role-bravo' } });
    const parent = makeParentChannel({ threadId: 'thread-roles' });
    guild.__channels.set('thread-roles', parent.thread);

    const { thread } = await matchService.createMatch({
      team1Identifier: alpha.team_id,
      team2Identifier: bravo.team_id,
      guild,
      parentChannel: parent,
    });

    expect(thread.messages[0]).toContain('<@&role-alpha>');
    expect(thread.messages[0]).toContain('<@&role-bravo>');
  });

  test('closing a match removes its thread', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    const parent = makeParentChannel({ threadId: 'thread-close' });
    guild.__channels.set('thread-close', parent.thread);

    const { match } = await matchService.createMatch({
      team1Identifier: alpha.team_id,
      team2Identifier: bravo.team_id,
      guild,
      parentChannel: parent,
    });

    await matchService.closeMatch(match.id, 'admin', { guild });
    expect(parent.thread.deleted).toBe(true);
  });

  test('rejects a team playing itself', async () => {
    const { alpha, guild } = await setupParticipants();
    await expect(
      matchService.createMatch({
        team1Identifier: alpha.team_id,
        team2Identifier: alpha.team_id,
        guild,
        parentChannel: makeParentChannel(),
      }),
    ).rejects.toThrow(/against itself/);
  });

  test('rejects inactive teams', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    await prisma.teams.update({ where: { team_id: bravo.team_id }, data: { is_active: false } });
    await expect(
      matchService.createMatch({
        team1Identifier: alpha.team_id,
        team2Identifier: bravo.team_id,
        guild,
        parentChannel: makeParentChannel(),
      }),
    ).rejects.toThrow(/active/);
  });

  test('rejects duplicate active match between the same teams', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    await matchService.createMatch({
      team1Identifier: alpha.team_id,
      team2Identifier: bravo.team_id,
      guild,
      parentChannel: makeParentChannel({ threadId: 'thread-1' }),
    });
    await expect(
      matchService.createMatch({
        team1Identifier: bravo.team_id,
        team2Identifier: alpha.team_id,
        guild,
        parentChannel: makeParentChannel({ threadId: 'thread-2' }),
      }),
    ).rejects.toThrow(/already exists/);
  });

  test('thread access is updated when a player changes team', async () => {
    const { alpha, bravo, guild } = await setupParticipants();
    const parent = makeParentChannel({ threadId: 'thread-1' });
    guild.__channels.set('thread-1', parent.thread);

    await matchService.createMatch({
      team1Identifier: alpha.team_id,
      team2Identifier: bravo.team_id,
      guild,
      parentChannel: parent,
    });

    const result = await matchService.syncThreadAccessForPlayer({
      guild,
      discordUserId: 'user-alpha',
      previousTeamId: alpha.team_id,
      newTeamId: bravo.team_id,
    });

    expect(result.removed).toContain((await matchService.findMatchByThreadId('thread-1')).id);
    expect(result.added).toContain((await matchService.findMatchByThreadId('thread-1')).id);
  });
});
