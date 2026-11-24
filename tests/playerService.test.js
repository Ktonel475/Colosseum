import prisma from '../src/database/prisma.js';
import * as playerService from '../src/services/playerService.js';
import * as teamService from '../src/services/teamService.js';
import { resetDb, seedTeams, makeGuild, makeMember } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

describe('player service', () => {
  test('first-time assignment stores player, team and role', async () => {
    const { alpha } = await seedTeams();
    await prisma.teams.update({
      where: { team_id: alpha.team_id },
      data: { discord_role_id: 'role-alpha' },
    });
    const guild = makeGuild({ roles: [{ id: 'role-alpha', name: 'Team Alpha' }] });
    const member = makeMember('user-1', guild, []);

    const result = await playerService.assignTeam({
      discordUserId: 'user-1',
      discordUsername: 'alice',
      teamId: alpha.team_id,
      guild,
      member,
    });

    expect(result.previousTeamId).toBeNull();
    const player = await prisma.players.findUnique({ where: { discord_user_id: 'user-1' } });
    expect(player.team_id).toBe(alpha.team_id);
    expect(player.team_role_id).toBe('role-alpha');
    expect(member.roles.cache.has('role-alpha')).toBe(true);
  });

  test('changing team removes the old role and adds the new one', async () => {
    const { alpha, bravo } = await seedTeams();
    await prisma.teams.update({ where: { team_id: alpha.team_id }, data: { discord_role_id: 'role-alpha' } });
    await prisma.teams.update({ where: { team_id: bravo.team_id }, data: { discord_role_id: 'role-bravo' } });

    const guild = makeGuild({
      roles: [
        { id: 'role-alpha', name: 'Team Alpha' },
        { id: 'role-bravo', name: 'Team Bravo' },
      ],
    });
    const member = makeMember('user-2', guild, ['role-alpha']);

    await playerService.assignTeam({
      discordUserId: 'user-2',
      discordUsername: 'bob',
      teamId: alpha.team_id,
      guild,
      member,
    });

    const result = await playerService.assignTeam({
      discordUserId: 'user-2',
      discordUsername: 'bob',
      teamId: bravo.team_id,
      guild,
      member,
    });

    expect(result.previousTeamId).toBe(alpha.team_id);
    expect(member.roles.cache.has('role-alpha')).toBe(false);
    expect(member.roles.cache.has('role-bravo')).toBe(true);

    const player = await prisma.players.findUnique({ where: { discord_user_id: 'user-2' } });
    expect(player.team_id).toBe(bravo.team_id);
  });

  test('rejects assigning an inactive team without changing the player', async () => {
    const { alpha, bravo } = await seedTeams();
    await teamService.deactivateTeam(bravo.team_id, 'admin');

    await playerService.assignTeam({
      discordUserId: 'user-3',
      discordUsername: 'carol',
      teamId: alpha.team_id,
    });

    await expect(
      playerService.assignTeam({
        discordUserId: 'user-3',
        discordUsername: 'carol',
        teamId: bravo.team_id,
      }),
    ).rejects.toThrow(/not active/);

    const player = await prisma.players.findUnique({ where: { discord_user_id: 'user-3' } });
    expect(player.team_id).toBe(alpha.team_id);
  });

  test('selection sessions expire', async () => {
    await playerService.createSelectionSession({
      discordUserId: 'user-4',
      discordUsername: 'dave',
      guildId: 'guild-1',
    });
    const active = await playerService.getActiveSelectionSession('user-4');
    expect(active).not.toBeNull();

    await prisma.player_selections.updateMany({
      where: { discord_user_id: 'user-4' },
      data: { expiration: new Date(Date.now() - 1000) },
    });
    const expired = await playerService.getActiveSelectionSession('user-4');
    expect(expired).toBeNull();
  });

  test('search returns only active teams', async () => {
    const { alpha, bravo } = await seedTeams();
    await teamService.deactivateTeam(bravo.team_id, 'admin');
    const results = await playerService.searchActiveTeams('');
    expect(results.map((t) => t.team_id)).toEqual(['T001']);
    expect(results[0].team_id).toBe(alpha.team_id);
  });

  test('initializePlayer starts team-less and resets an existing assignment', async () => {
    const { alpha } = await seedTeams();
    await playerService.initializePlayer({ discordUserId: 'dev-1', discordUsername: 'devuser' });
    let player = await prisma.players.findUnique({ where: { discord_user_id: 'dev-1' } });
    expect(player.discord_username).toBe('devuser');
    expect(player.team_id).toBeNull();

    await playerService.assignTeam({
      discordUserId: 'dev-1',
      discordUsername: 'devuser',
      teamId: alpha.team_id,
    });
    const result = await playerService.initializePlayer({
      discordUserId: 'dev-1',
      discordUsername: 'devuser2',
    });
    expect(result.previousTeamId).toBe(alpha.team_id);

    player = await prisma.players.findUnique({ where: { discord_user_id: 'dev-1' } });
    expect(player.discord_username).toBe('devuser2');
    expect(player.team_id).toBeNull();
    expect(player.team_role_id).toBeNull();
  });

  test('search matches team code and name case-insensitively', async () => {
    await seedTeams();
    const byCode = await playerService.searchActiveTeams('t001');
    expect(byCode.map((t) => t.team_id)).toEqual(['T001']);

    const byName = await playerService.searchActiveTeams('team alph');
    expect(byName.map((t) => t.team_id)).toEqual(['T001']);

    const partial = await playerService.searchActiveTeams('t00');
    expect(partial.map((t) => t.team_id)).toEqual(['T001', 'T002']);
  });
});
