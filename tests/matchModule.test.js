import prisma from '../src/database/prisma.js';
import { makeGuild, resetDb, seedTeams } from './helpers.js';
import { createTranslator, preloadLocales, resolveLocale, t } from '../src/utils/i18n.js';
import { matchCommandDefinitions } from '../src/modules/match/commands.js';
import {
  MatchModuleError,
  createBulkMatches,
  createMatch,
  recordResult,
} from '../src/modules/match/service.js';
import { MemoryMatchRepository } from '../src/modules/match/repository/memoryRepository.js';
import { PrismaMatchRepository } from '../src/modules/match/repository/prismaRepository.js';
import { handleMatchCommand, handleMatchComponent } from '../src/modules/match/handlers.js';
import { LEGACY_MATCH_COMMANDS, applyMatchModuleMode } from '../src/bot/registerCommands.js';

beforeAll(() => preloadLocales());
beforeEach(async () => {
  await resetDb();
  await seedTeams();
});
afterAll(async () => prisma.$disconnect());

function makeRoundChannel(id = 'round-1') {
  const created = [];
  return {
    id,
    created,
    isThread: () => false,
    threads: {
      create: async (options) => {
        const thread = {
          id: `thread-${created.length + 1}`,
          name: options.name,
          options,
          messages: [],
          delete: async () => {},
          send: async (payload) => {
            thread.messages.push(payload);
            return payload;
          },
        };
        created.push(thread);
        return thread;
      },
    },
  };
}

function makeInteraction(overrides = {}) {
  const state = { replies: [], edits: [], updates: [], deferred: false, replied: false };
  const interaction = {
    commandName: 'match-create',
    locale: 'en',
    user: { id: 'admin-1', username: 'admin' },
    member: { roles: { cache: { has: () => false } } },
    channel: null,
    guild: { members: { fetch: async () => null } },
    client: {
      users: {
        fetch: async (id) => ({ id, username: `user-${id}`, displayName: `User ${id}` }),
      },
      channels: { fetch: async () => null },
    },
    values: [],
    options: { getUser: () => null, getString: () => null },
    ...overrides,
  };
  interaction.reply = async (payload) => {
    state.replied = true;
    state.replies.push(payload);
  };
  interaction.deferReply = async () => {
    state.deferred = true;
  };
  interaction.editReply = async (payload) => {
    state.replied = true;
    state.edits.push(payload);
  };
  interaction.followUp = async (payload) => {
    state.replies.push(payload);
  };
  interaction.update = async (payload) => {
    state.replied = true;
    state.updates.push(payload);
  };
  interaction.deferUpdate = async () => {
    state.deferred = true;
  };
  state.interaction = interaction;
  return state;
}

function withRoles(...roleIds) {
  return { roles: { cache: { has: (id) => roleIds.includes(id) } } };
}

function threadChannel(id = 'thread-1') {
  return { id, isThread: () => true };
}

/* Team roles used by the /match-create ping tests. */
const TEAM_ROLE_IDS = {
  'Team Alpha': '111111111111111111',
  'Team Bravo': '222222222222222222',
  'Team Charlie': '333333333333333333',
  'Team Delta': '444444444444444444',
};

function teamGuild() {
  return makeGuild({
    roles: Object.entries(TEAM_ROLE_IDS).map(([name, id]) => ({ id, name })),
  });
}

describe('project i18n', () => {
  test('resolves Thai locales and falls back to English', () => {
    expect(resolveLocale('th')).toBe('th');
    expect(resolveLocale('th-TH')).toBe('th');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  test('interpolates localized templates', () => {
    expect(t('en', 'match.thread_name_template', { team1: 'A', team2: 'B' })).toBe('A vs B');
    expect(t('th-TH', 'match.thread_name_template', { team1: 'A', team2: 'B' })).toBe('A พบ B');
    expect(t('fr', 'match.self_match_error')).toBe(t('en', 'match.self_match_error'));
    expect(t('en', 'missing_key')).toBe('missing_key');
  });

  test('namespaced translators resolve match keys', () => {
    const tr = createTranslator('match');
    expect(tr('en', 'self_match_error')).toBe(t('en', 'match.self_match_error'));
    expect(tr('th', 'self_match_error')).toBe(t('th', 'match.self_match_error'));
  });

  test('has every required key in both dictionaries', () => {
    const required = [
      'match.role_gate_denied',
      'match.self_match_error',
      'match.thread_name_template',
      'match.match_created_success',
      'match.bulk_summary',
      'match.result_outside_thread',
      'match.admin_gate_denied',
      'match.winner_prompt',
      'match.confirm_label',
      'match.cancel_label',
      'match.result_embed',
      'match.cancel_notice',
    ];
    for (const locale of ['en', 'th']) {
      for (const key of required) {
        expect(t(locale, key)).not.toBe(key);
      }
    }
  });
});

describe('match module only toggle', () => {
  test('keeps both subsystems when disabled', () => {
    const definitions = [{ name: 'match-create' }, { name: 'match-list' }, { name: 'team-list' }];
    expect(applyMatchModuleMode(definitions, false)).toEqual(definitions);
  });

  test('removes legacy match/result commands when enabled', () => {
    const definitions = [
      { name: 'team-list' },
      { name: 'match-create' },
      { name: 'match-create-bulk' },
      { name: 'result' },
      ...[...LEGACY_MATCH_COMMANDS].map((name) => ({ name })),
    ];
    const names = applyMatchModuleMode(definitions, true).map((command) => command.name);
    expect(names).toEqual(['team-list', 'match-create', 'match-create-bulk', 'result']);
    for (const legacy of LEGACY_MATCH_COMMANDS) expect(names).not.toContain(legacy);
  });
});

describe('match module commands', () => {
  test('registers the two required user options before the optional channel', () => {
    const definitions = matchCommandDefinitions.map((command) => command.toJSON());
    expect(definitions.map((c) => c.name).sort()).toEqual([
      'match-create',
      'match-create-bulk',
      'result',
    ]);

    const create = definitions.find((c) => c.name === 'match-create');
    expect(create.options.map((o) => o.name)).toEqual([
      'team1',
      'team2',
      'require_role',
      'channel',
    ]);

    const channelOption = create.options.find((o) => o.name === 'channel');
    expect(channelOption).toMatchObject({ type: 7, required: false });
    expect(channelOption.channel_types).toEqual([0, 5]); // GuildText, GuildAnnouncement

    const teamOptions = create.options.filter((o) => o.name === 'team1' || o.name === 'team2');
    expect(teamOptions.map((o) => o.name)).toEqual(['team1', 'team2']);
    for (const option of teamOptions) {
      expect(option).toMatchObject({ type: 3, required: true, autocomplete: true });
    }
  });
});

describe('match service', () => {
  test('creates a localized thread and persists the record', async () => {
    const repository = new MemoryMatchRepository();
    const channel = makeRoundChannel();
    const { record, thread } = await createMatch({
      roundChannel: channel,
      team1: { id: 'u1', name: 'Alice' },
      team2: { id: 'u2', name: 'Bob' },
      locale: 'en',
      repository,
    });

    expect(thread.name).toBe('Alice vs Bob');
    expect(record).toMatchObject({
      roundChannelId: 'round-1',
      threadId: thread.id,
      team1Id: 'u1',
      team2Id: 'u2',
      status: 'active',
    });
    await expect(repository.findByThreadId(thread.id)).resolves.toMatchObject({ team1Id: 'u1' });
  });

  test('uses the Thai thread name template', async () => {
    const { thread } = await createMatch({
      roundChannel: makeRoundChannel(),
      team1: { id: 'u1', name: 'Alice' },
      team2: { id: 'u2', name: 'Bob' },
      locale: 'th-TH',
      repository: new MemoryMatchRepository(),
    });
    expect(thread.name).toBe('Alice พบ Bob');
  });

  test('rejects a match against the same user id', async () => {
    await expect(
      createMatch({
        roundChannel: makeRoundChannel(),
        team1: { id: 'u1', name: 'Alice' },
        team2: { id: 'u1', name: 'Alice' },
        locale: 'en',
        repository: new MemoryMatchRepository(),
      }),
    ).rejects.toMatchObject({ key: 'self_match_error' });
  });

  test('records a result once and marks the match completed', async () => {
    const repository = new MemoryMatchRepository();
    const { thread } = await createMatch({
      roundChannel: makeRoundChannel(),
      team1: { id: 'u1', name: 'Alice' },
      team2: { id: 'u2', name: 'Bob' },
      locale: 'en',
      repository,
    });

    const { match, result } = await recordResult({
      threadId: thread.id,
      winner: 'team2',
      decidedBy: 'admin-1',
      repository,
    });
    expect(match.status).toBe('completed');
    expect(match.completedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ winner: 'team2', winnerId: 'u2', decidedBy: 'admin-1' });

    await expect(
      recordResult({ threadId: thread.id, winner: 'team1', decidedBy: 'admin-1', repository }),
    ).rejects.toMatchObject({ key: 'result_already_completed' });
  });

  test('bulk creation reports per-pair success and failure', async () => {
    const results = await createBulkMatches({
      roundChannel: makeRoundChannel(),
      pairs: [
        { team1: { id: 'u1', name: 'A' }, team2: { id: 'u2', name: 'B' } },
        { team1: { id: 'u3', name: 'C' }, team2: { id: 'u3', name: 'C' } },
      ],
      locale: 'en',
      repository: new MemoryMatchRepository(),
    });
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toBe(t('en', 'match.self_match_error'));
  });

  test('prisma repository round-trips records', async () => {
    const repository = new PrismaMatchRepository();
    const record = await repository.create({
      roundChannelId: 'round-db',
      threadId: 'thread-db',
      team1Id: 'u1',
      team2Id: 'u2',
    });
    expect(record.status).toBe('active');

    const completed = await repository.complete('thread-db', {
      result: { winner: 'team1', winnerId: 'T001' },
      completedAt: new Date(),
    });
    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual({ winner: 'team1', winnerId: 'T001' });
    expect(await repository.listByRound('round-db')).toHaveLength(1);
  });
});

describe('match command handlers', () => {
  test('rejects users without the administrator role (localized)', async () => {
    const state = makeInteraction({
      locale: 'th',
      channel: makeRoundChannel(),
      options: {
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
      },
    });
    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(t('th', 'match.role_gate_denied'));
  });

  test('rejects a self-match', async () => {
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel: makeRoundChannel(),
      options: { getString: () => 'T001' },
    });
    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(t('en', 'match.self_match_error'));
  });

  test('rejects an unknown team name', async () => {
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel: makeRoundChannel(),
      options: {
        getString: (name) => (name === 'team1' ? 'T001' : 'Missing Team'),
      },
    });
    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(
      t('en', 'match.team_not_found', { team: 'Missing Team' }),
    );
  });

  test('creates a thread via /match-create from team names and pings both roles', async () => {
    const channel = makeRoundChannel();
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      guild: teamGuild(),
      options: {
        getString: (name) => (name === 'team1' ? 'Team Alpha' : 'T002'),
        getBoolean: () => true,
      },
    });
    await handleMatchCommand(state.interaction);

    expect(channel.created).toHaveLength(1);
    expect(channel.created[0].name).toBe('Team Alpha vs Team Bravo');
    expect(state.edits[0]).toContain('<#thread-1>');

    // The intro message must ping the destination team roles, not just names.
    const intro = channel.created[0].messages[0];
    expect(intro).toContain(`<@&${TEAM_ROLE_IDS['Team Alpha']}>`);
    expect(intro).toContain(`<@&${TEAM_ROLE_IDS['Team Bravo']}>`);

    const repository = new PrismaMatchRepository();
    const saved = await repository.findByThreadId('thread-1');
    expect(saved).toMatchObject({ team1Id: 'T001', team2Id: 'T002' });
  });

  test('pings roles when require_role is explicitly enabled', async () => {
    const channel = makeRoundChannel();
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      guild: teamGuild(),
      options: {
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
        getBoolean: (name) => (name === 'require_role' ? true : null),
      },
    });
    await handleMatchCommand(state.interaction);

    expect(channel.created).toHaveLength(1);
    const intro = channel.created[0].messages[0];
    expect(intro).toContain(`<@&${TEAM_ROLE_IDS['Team Alpha']}>`);
    expect(intro).toContain(`<@&${TEAM_ROLE_IDS['Team Bravo']}>`);
  });

  test('rejects the match when require_role is enabled and a role is missing', async () => {
    const channel = makeRoundChannel();
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      guild: makeGuild({ roles: [{ id: '111111111111111111', name: 'Team Alpha' }] }),
      options: {
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
        getBoolean: () => true,
      },
    });
    await handleMatchCommand(state.interaction);

    expect(channel.created).toHaveLength(0);
    expect(state.replies[0].content).toBe(
      t('en', 'match.team_role_not_found', { team: 'Team Bravo' }),
    );
  });

  test('allows a plain-name intro when require_role is disabled', async () => {
    const channel = makeRoundChannel();
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      guild: makeGuild({ roles: [] }),
      options: {
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
        getBoolean: (name) => (name === 'require_role' ? false : null),
      },
    });
    await handleMatchCommand(state.interaction);

    expect(channel.created).toHaveLength(1);
    const intro = channel.created[0].messages[0];
    expect(intro).toContain('Team Alpha');
    expect(intro).toContain('Team Bravo');
    expect(intro).not.toContain('<@&');
  });

  test('uses the channel option instead of the current channel', async () => {
    const current = makeRoundChannel('round-current');
    const selected = makeRoundChannel('round-selected');
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel: current,
      guild: teamGuild(),
      options: {
        getChannel: (name) => (name === 'channel' ? selected : null),
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
        getBoolean: () => true,
      },
    });

    await handleMatchCommand(state.interaction);

    expect(current.created).toHaveLength(0);
    expect(selected.created).toHaveLength(1);
    const saved = await new PrismaMatchRepository().findByThreadId('thread-1');
    expect(saved.roundChannelId).toBe('round-selected');
    expect(state.edits[0]).toContain('<#thread-1>');
  });

  test('rejects a selected channel that cannot host threads', async () => {
    const selected = { id: 'voice-1' }; // no threads.create
    const state = makeInteraction({
      member: withRoles('role-admin'),
      channel: makeRoundChannel(),
      options: {
        getChannel: () => selected,
        getString: (name) => (name === 'team1' ? 'T001' : 'T002'),
      },
    });

    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(t('en', 'match.round_channel_required'));
  });

  test('bulk panel creates N threads from team names in one flow', async () => {
    await prisma.teams.create({
      data: { team_id: 'T003', team_name: 'Team Charlie', game_type: 'Game B' },
    });
    await prisma.teams.create({
      data: { team_id: 'T004', team_name: 'Team Delta', game_type: 'Game B' },
    });
    const channel = makeRoundChannel();
    const panel = makeInteraction({
      commandName: 'match-create-bulk',
      member: withRoles('role-admin'),
      channel,
      guild: teamGuild(),
    });
    await handleMatchCommand(panel.interaction);
    const token = panel.replies[0].components[0].components[0].data.custom_id.split(':')[3];

    const pick = async (team, teamId) => {
      const state = makeInteraction({
        member: withRoles('role-admin'),
        channel,
        guild: teamGuild(),
        customId: `matchmod:bulk:${team}:${token}`,
        values: [teamId],
      });
      await handleMatchComponent(state.interaction);
      return state;
    };

    const click = async (action) => {
      const state = makeInteraction({
        member: withRoles('role-admin'),
        channel,
        guild: teamGuild(),
        customId: `matchmod:bulk:${action}:${token}`,
      });
      await handleMatchComponent(state.interaction);
      return state;
    };

    await pick('t1', 'T001');
    await pick('t2', 'T002');
    await click('add');
    await pick('t1', 'T003');
    await pick('t2', 'T004');
    const added = await click('add');
    expect(added.updates.at(-1).content).toContain('Team Charlie');

    const confirmed = await click('confirm');
    expect(channel.created).toHaveLength(2);
    expect(confirmed.edits[0].content).toContain('Created 2 of 2');

    const repository = new PrismaMatchRepository();
    expect(await repository.listByRound('round-1')).toHaveLength(2);
  });
});

describe('result flow', () => {
  async function seedThread() {
    const repository = new PrismaMatchRepository();
    await repository.create({
      roundChannelId: 'round-1',
      threadId: 'thread-1',
      team1Id: 'T001',
      team2Id: 'T002',
    });
    return repository;
  }

  function makeClient(posted) {
    return {
      users: {
        fetch: async (id) => ({ id, username: `user-${id}`, displayName: `User ${id}` }),
      },
      channels: {
        fetch: async () => ({ send: async (payload) => posted.push(payload) }),
      },
    };
  }

  test('refuses outside a match thread', async () => {
    const state = makeInteraction({
      commandName: 'result',
      member: withRoles('role-admin'),
      channel: makeRoundChannel(),
    });
    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(t('en', 'match.result_outside_thread'));
  });

  test('refuses non-admins', async () => {
    const state = makeInteraction({
      commandName: 'result',
      channel: threadChannel(),
    });
    await handleMatchCommand(state.interaction);
    expect(state.replies[0].content).toBe(t('en', 'match.admin_gate_denied'));
  });

  test('requires confirmation from the same admin and persists the result', async () => {
    const repository = await seedThread();
    const posted = [];
    const client = makeClient(posted);
    const channel = threadChannel();

    const command = makeInteraction({
      commandName: 'result',
      member: withRoles('role-admin'),
      channel,
      client,
    });
    await handleMatchCommand(command.interaction);
    expect(command.replies[0].content).toBe(
      t('en', 'match.winner_prompt', { team1: 'Team Alpha', team2: 'Team Bravo' }),
    );

    const pick = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      client,
      customId: 'matchmod:result:pick:thread-1',
      values: ['team1'],
    });
    await handleMatchComponent(pick.interaction);
    const confirmPayload = pick.updates[0];
    expect(confirmPayload.content).toContain('Team Alpha');
    const token = confirmPayload.components[0].components[0].data.custom_id.split(':')[3];

    const otherAdmin = makeInteraction({
      user: { id: 'admin-2', username: 'other' },
      member: withRoles('role-admin'),
      channel,
      client,
      customId: `matchmod:result:confirm:${token}`,
    });
    await handleMatchComponent(otherAdmin.interaction);
    expect(otherAdmin.replies[0].content).toBe(t('en', 'match.result_only_requester'));
    expect((await repository.findByThreadId('thread-1')).status).toBe('active');

    const requester = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      client,
      customId: `matchmod:result:confirm:${token}`,
    });
    await handleMatchComponent(requester.interaction);
    expect(requester.edits[0].content).toBe(t('en', 'match.result_confirmed'));
    expect(posted).toHaveLength(1);

    const saved = await repository.findByThreadId('thread-1');
    expect(saved.status).toBe('completed');
    expect(saved.result).toMatchObject({ winner: 'team1', winnerId: 'T001', decidedBy: 'admin-1' });
  });

  test('cancel dismisses without completing the match', async () => {
    const repository = await seedThread();
    const posted = [];
    const client = makeClient(posted);
    const channel = threadChannel();

    const pick = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      client,
      customId: 'matchmod:result:pick:thread-1',
      values: ['team2'],
    });
    await handleMatchComponent(pick.interaction);
    const token = pick.updates[0].components[0].components[1].data.custom_id.split(':')[3];

    const cancel = makeInteraction({
      member: withRoles('role-admin'),
      channel,
      client,
      customId: `matchmod:result:cancel:${token}`,
    });
    await handleMatchComponent(cancel.interaction);
    expect(cancel.updates[0].content).toBe(t('en', 'match.cancel_notice'));
    expect((await repository.findByThreadId('thread-1')).status).toBe('active');
  });
});

describe('MatchModuleError', () => {
  test('carries the locale key and params', () => {
    const err = new MatchModuleError('generic_error', { error: 'boom' });
    expect(err.key).toBe('generic_error');
    expect(err.params).toEqual({ error: 'boom' });
  });
});
