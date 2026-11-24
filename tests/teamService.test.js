import prisma from '../src/database/prisma.js';
import * as teamService from '../src/services/teamService.js';
import { resetDb, seedTeams } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

describe('team service', () => {
  test('preview and apply a new import', async () => {
    const rows = [
      { team_id: 'T001', team_name: 'Team Alpha' },
      { team_id: 'T002', team_name: 'Team Bravo' },
    ];
    const preview = await teamService.previewImport(rows);
    expect(preview.counts).toMatchObject({ new: 2, updated: 0, removed: 0 });

    const applied = await teamService.applyImport(rows, { actorDiscordId: 'admin-1' });
    expect(applied.created).toHaveLength(2);
    expect(await prisma.teams.count()).toBe(2);
  });

  test('import updates names and deactivates removed teams', async () => {
    const { alpha } = await seedTeams();
    const applied = await teamService.applyImport(
      [
        { team_id: 'T001', team_name: 'Team Alpha Renamed' },
        { team_id: 'T003', team_name: 'Team Charlie' },
      ],
      { actorDiscordId: 'admin-1' },
    );
    expect(applied.updated).toHaveLength(1);
    expect(applied.deactivated).toHaveLength(1);

    const renamed = await prisma.teams.findUnique({ where: { team_id: alpha.team_id } });
    expect(renamed.team_name).toBe('Team Alpha Renamed');
    expect(renamed.is_active).toBe(true);

    const bravo = await prisma.teams.findUnique({ where: { team_id: 'T002' } });
    expect(bravo.is_active).toBe(false);
  });

  test('adding a duplicate team ID throws', async () => {
    await seedTeams();
    await expect(
      teamService.addTeam({ team_id: 'T001', team_name: 'Another' }, 'admin'),
    ).rejects.toThrow(/already exists/);
  });

  test('deactivating a team preserves the record', async () => {
    const { alpha } = await seedTeams();
    const deactivated = await teamService.deactivateTeam(alpha.team_id, 'admin');
    expect(deactivated.is_active).toBe(false);
    expect(await prisma.teams.count()).toBe(2);
  });

  test('imports and updates the game type; absent game type preserves the old value', async () => {
    await teamService.applyImport(
      [{ team_id: 'T010', team_name: 'Team X', game_type: 'CS2' }],
      { actorDiscordId: 'admin' },
    );
    let team = await prisma.teams.findUnique({ where: { team_id: 'T010' } });
    expect(team.game_type).toBe('CS2');

    await teamService.applyImport(
      [{ team_id: 'T010', team_name: 'Team X', game_type: 'RoV' }],
      { actorDiscordId: 'admin' },
    );
    team = await prisma.teams.findUnique({ where: { team_id: 'T010' } });
    expect(team.game_type).toBe('RoV');

    await teamService.applyImport(
      [{ team_id: 'T010', team_name: 'Team X' }],
      { actorDiscordId: 'admin' },
    );
    team = await prisma.teams.findUnique({ where: { team_id: 'T010' } });
    expect(team.game_type).toBe('RoV');
  });

  test('adds a team with game type and uses team code as primary key', async () => {
    const team = await teamService.addTeam(
      { team_id: 'T020', team_name: 'Team Y', game_type: 'RoV' },
      'admin',
    );
    expect(team.team_id).toBe('T020');
    expect(team.game_type).toBe('RoV');
    const found = await prisma.teams.findUnique({ where: { team_id: 'T020' } });
    expect(found.team_name).toBe('Team Y');
  });

  test('allows the same team name in different game types', async () => {
    const roster = [
      { team_id: 'T100', team_name: 'Somsri ESports', game_type: 'RoV' },
      { team_id: 'T101', team_name: 'Somsri ESports', game_type: 'CS2' },
    ];
    const preview = await teamService.previewImport(roster);
    expect(preview.counts.new).toBe(2);
    expect(preview.updatedTeams).toHaveLength(0);

    const applied = await teamService.applyImport(roster, { actorDiscordId: 'admin' });
    expect(applied.created).toHaveLength(2);
    expect(await prisma.teams.count({ where: { team_name: 'Somsri ESports' } })).toBe(2);
  });

  test('rejects the same team name in the same game type on import', async () => {
    await teamService.applyImport(
      [{ team_id: 'T200', team_name: 'Somsri ESports', game_type: 'RoV' }],
      { actorDiscordId: 'admin' },
    );
    await expect(
      teamService.applyImport(
        [{ team_id: 'T201', team_name: 'Somsri ESports', game_type: 'RoV' }],
        { actorDiscordId: 'admin' },
      ),
    ).rejects.toThrow(/already belongs to team T200/);
  });

  test('addTeam allows a duplicate name in a different game type', async () => {
    await teamService.addTeam(
      { team_id: 'T300', team_name: 'Somsri ESports', game_type: 'RoV' },
      'admin',
    );
    const second = await teamService.addTeam(
      { team_id: 'T301', team_name: 'Somsri ESports', game_type: 'CS2' },
      'admin',
    );
    expect(second.team_id).toBe('T301');
    await expect(
      teamService.addTeam(
        { team_id: 'T302', team_name: 'Somsri ESports', game_type: 'RoV' },
        'admin',
      ),
    ).rejects.toThrow(/already exists/);
  });

  test('name lookup is ambiguous when the name is shared', async () => {
    await teamService.applyImport(
      [
        { team_id: 'T400', team_name: 'Somsri ESports', game_type: 'RoV' },
        { team_id: 'T401', team_name: 'Somsri ESports', game_type: 'CS2' },
      ],
      { actorDiscordId: 'admin' },
    );
    await expect(teamService.getTeam('Somsri ESports')).rejects.toThrow(/Multiple teams/);
    const exact = await teamService.getTeam('T401');
    expect(exact.team_id).toBe('T401');
  });

  test('listTeams excludes inactive teams by default', async () => {
    const { alpha } = await seedTeams();
    await teamService.deactivateTeam(alpha.team_id, 'admin');
    const active = await teamService.listTeams({});
    expect(active.map((t) => t.team_id)).toEqual(['T002']);
    const all = await teamService.listTeams({ includeInactive: true });
    expect(all).toHaveLength(2);
  });
});
