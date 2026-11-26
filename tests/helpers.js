import prisma from '../src/database/prisma.js';

export async function resetDb() {
  await prisma.$transaction([
    prisma.result_confirmations.deleteMany(),
    prisma.results.deleteMany(),
    prisma.matches.deleteMany(),
    prisma.match_module_records.deleteMany(),
    prisma.players.deleteMany(),
    prisma.player_selections.deleteMany(),
    prisma.user_settings.deleteMany(),
    prisma.teams.deleteMany(),
    prisma.audit_logs.deleteMany(),
  ]);
}

export async function seedTeams() {
  const alpha = await prisma.teams.create({
    data: { team_id: 'T001', team_name: 'Team Alpha' },
  });
  const bravo = await prisma.teams.create({
    data: { team_id: 'T002', team_name: 'Team Bravo' },
  });
  return { alpha, bravo };
}

export function makeRole(id, name) {
  return { id, name };
}

export function makeGuild({ roles = [], members = [] } = {}) {
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const memberMap = new Map(members.map((m) => [m.id, m]));

  const rolesApi = {
    cache: {
      get: (id) => roleMap.get(id),
      find: (fn) => [...roleMap.values()].find(fn),
      has: (id) => roleMap.has(id),
    },
    create: async ({ name }) => {
      const role = makeRole(`role-${name}`, name);
      roleMap.set(role.id, role);
      role.members = new Map();
      return role;
    },
  };

  // give existing roles a members collection
  for (const role of roleMap.values()) {
    if (!role.members) role.members = new Map();
  }

  const guild = {
    id: 'guild-1',
    roles: rolesApi,
    members: {
      cache: { get: (id) => memberMap.get(id) },
      fetch: async (id) => memberMap.get(id) ?? Promise.reject(new Error('unknown member')),
    },
    channels: {
      fetch: async (id) => guild.__channels?.get(id),
      cache: { get: (id) => guild.__channels?.get(id) },
    },
    __channels: new Map(),
    __addMember(member) {
      memberMap.set(member.id, member);
      return member;
    },
  };
  return guild;
}

export function makeMember(id, guild, initialRoleIds = []) {
  const roleCache = new Map();
  for (const roleId of initialRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (role) roleCache.set(roleId, role);
  }

  const member = {
    id,
    user: { id, username: `user-${id}` },
    roles: {
      cache: {
        has: (roleId) => roleCache.has(roleId),
        filter: (fn) => {
          const result = new Map();
          for (const [k, v] of roleCache) if (fn(v)) result.set(k, v);
          return result;
        },
        values: () => roleCache.values(),
      },
      add: async (role) => {
        roleCache.set(role.id, role);
        role.members?.set(id, member);
      },
      remove: async (role) => {
        roleCache.delete(role.id);
        role.members?.delete(id);
      },
      set: async (roles) => {
        roleCache.clear();
        for (const role of roles) roleCache.set(role.id, role);
      },
    },
  };
  return member;
}

export function makeThread(id, name = 'thread') {
  const messages = [];
  const members = new Set();
  const thread = {
    id,
    name,
    messages,
    memberIds: members,
    deleted: false,
    members: {
      add: async (userId) => members.add(userId),
      remove: async (userId) => members.delete(userId),
    },
    send: async (payload) => {
      messages.push(payload);
      return payload;
    },
    setArchived: async (v) => {
      messages.push({ archived: v });
    },
    setLocked: async (v) => {
      messages.push({ locked: v });
    },
    delete: async () => {
      thread.deleted = true;
    },
  };
  return thread;
}

export function makeParentChannel({ threadId = 'thread-1', threadName = 'match' } = {}) {
  const thread = makeThread(threadId, threadName);
  return {
    id: 'parent-1',
    thread,
    threads: {
      create: async () => thread,
    },
  };
}
