import prisma from '../src/database/prisma.js';
import * as resultService from '../src/services/resultService.js';
import { resetDb, seedTeams } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

async function setupMatch({ status = 'active', threadId = 'thread-r1' } = {}) {
  const { alpha, bravo } = await seedTeams();
  const match = await prisma.matches.create({
    data: {
      team1_id: alpha.team_id,
      team2_id: bravo.team_id,
      discord_thread_id: threadId,
      status,
    },
  });
  await prisma.players.create({
    data: { discord_user_id: 'p-alpha', discord_username: 'alpha-player', team_id: alpha.team_id },
  });
  await prisma.players.create({
    data: { discord_user_id: 'p-bravo', discord_username: 'bravo-player', team_id: bravo.team_id },
  });
  await prisma.players.create({
    data: { discord_user_id: 'p-outsider', discord_username: 'outsider', team_id: null },
  });
  return { alpha, bravo, match };
}

describe('result service', () => {
  test('valid submission creates pending result', async () => {
    await setupMatch();
    const { result, match } = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 2,
      score2: 1,
      policy: 'both_teams',
    });
    expect(result.status).toBe('pending');
    expect(result.match_id).toBe(match.id);
    expect(result.score1).toBe(2);
    expect(result.score2).toBe(1);
  });

  test('rejects submission outside a match thread', async () => {
    await setupMatch();
    await expect(
      resultService.submitResult({
        threadId: null,
        discordUserId: 'p-alpha',
        score1: 1,
        score2: 0,
      }),
    ).rejects.toThrow(/match thread/);
  });

  test('rejects submission from an unrelated player', async () => {
    await setupMatch();
    await expect(
      resultService.submitResult({
        threadId: 'thread-r1',
        discordUserId: 'p-outsider',
        score1: 1,
        score2: 0,
      }),
    ).rejects.toThrow(/not registered|participating team/);
  });

  test('rejects invalid scores', async () => {
    await setupMatch();
    await expect(
      resultService.submitResult({
        threadId: 'thread-r1',
        discordUserId: 'p-alpha',
        score1: -1,
        score2: 0,
      }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      resultService.submitResult({
        threadId: 'thread-r1',
        discordUserId: 'p-alpha',
        score1: 1.5,
        score2: 0,
      }),
    ).rejects.toThrow(/integer/);
  });

  test('rejects duplicate submissions', async () => {
    await setupMatch();
    await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 1,
      score2: 0,
      policy: 'both_teams',
    });
    await expect(
      resultService.submitResult({
        threadId: 'thread-r1',
        discordUserId: 'p-bravo',
        score1: 0,
        score2: 1,
        policy: 'both_teams',
      }),
    ).rejects.toThrow(/already been submitted/);
  });

  test('rejects submission for a closed match', async () => {
    await setupMatch({ status: 'closed' });
    await expect(
      resultService.submitResult({
        threadId: 'thread-r1',
        discordUserId: 'p-alpha',
        score1: 1,
        score2: 0,
      }),
    ).rejects.toThrow(/closed/);
  });

  test('both-teams policy requires one confirmation from each team', async () => {
    await setupMatch();
    const { result } = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 2,
      score2: 1,
      policy: 'both_teams',
    });

    const afterFirst = await resultService.confirmResult({
      resultId: result.id,
      discordUserId: 'p-alpha',
      policy: 'both_teams',
    });
    expect(afterFirst.status).toBe('pending');

    await expect(
      resultService.confirmResult({
        resultId: result.id,
        discordUserId: 'p-alpha',
        policy: 'both_teams',
      }),
    ).rejects.toThrow(/already confirmed/);

    const afterSecond = await resultService.confirmResult({
      resultId: result.id,
      discordUserId: 'p-bravo',
      policy: 'both_teams',
    });
    expect(afterSecond.status).toBe('final');
    expect(afterSecond.confirmed_at).toBeInstanceOf(Date);
  });

  test('administrator policy finalizes on admin confirmation', async () => {
    await setupMatch();
    const { result } = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 3,
      score2: 0,
      policy: 'administrator',
    });
    const finalized = await resultService.adminConfirmResult({
      resultId: result.id,
      actorDiscordId: 'admin-1',
      policy: 'administrator',
    });
    expect(finalized.status).toBe('final');
  });

  test('automatic policy finalizes immediately', async () => {
    await setupMatch();
    const { result } = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 1,
      score2: 1,
      policy: 'automatic',
    });
    expect(result.status).toBe('final');
  });

  test('administrative correction writes an audit record with old and new values', async () => {
    await setupMatch();
    const { result } = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 2,
      score2: 0,
      policy: 'both_teams',
    });
    const updated = await resultService.editResult({
      resultId: result.id,
      score1: 0,
      score2: 2,
      actorDiscordId: 'admin-1',
    });
    expect(updated.score1).toBe(0);
    expect(updated.score2).toBe(2);

    const audit = await prisma.audit_logs.findFirst({
      where: { action: 'RESULT_EDIT', entity_id: result.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit.previous_value)).toMatchObject({ score1: 2, score2: 0 });
    expect(JSON.parse(audit.new_value)).toMatchObject({ score1: 0, score2: 2 });
  });

  test('a submitter can cancel a pending result but final results cannot be cancelled', async () => {
    await setupMatch();
    const pending = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 1,
      score2: 0,
      policy: 'both_teams',
    });
    const cancelled = await resultService.cancelResult({
      resultId: pending.result.id,
      actorDiscordId: 'p-alpha',
      isAdmin: false,
      requesterId: 'p-alpha',
    });
    expect(cancelled.status).toBe('cancelled');

    const auto = await resultService.submitResult({
      threadId: 'thread-r1',
      discordUserId: 'p-alpha',
      score1: 1,
      score2: 0,
      policy: 'automatic',
    });
    await expect(
      resultService.cancelResult({
        resultId: auto.result.id,
        actorDiscordId: 'admin',
        isAdmin: true,
        requesterId: 'admin',
      }),
    ).rejects.toThrow(/Final results/);
  });
});
