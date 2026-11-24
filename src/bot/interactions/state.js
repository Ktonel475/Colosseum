import { randomUUID } from 'node:crypto';
import config from '../../config/index.js';

const pendingSelections = new Map();
const pendingImports = new Map();

const TTL = config.interactionExpiration;

function sweep(map) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

setInterval(() => {
  sweep(pendingSelections);
  sweep(pendingImports);
}, Math.min(TTL, 60_000)).unref?.();

export function createPendingSelection({ discordUserId, teamId, guildId }) {
  const token = randomUUID();
  pendingSelections.set(token, {
    token,
    discordUserId,
    teamId,
    guildId,
    used: false,
    expiresAt: Date.now() + TTL,
  });
  return token;
}

/**
 * Atomically claim a pending selection. Returns null if missing, expired, or
 * already used (protects against duplicate button clicks).
 */
export function consumePendingSelection(token, discordUserId) {
  const entry = pendingSelections.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pendingSelections.delete(token);
    return null;
  }
  if (entry.discordUserId !== discordUserId) return { forbidden: true };
  if (entry.used) return { duplicate: true };
  entry.used = true;
  return entry;
}

export function cancelPendingSelection(token, discordUserId) {
  const entry = pendingSelections.get(token);
  if (!entry || entry.discordUserId !== discordUserId) return false;
  pendingSelections.delete(token);
  return true;
}

export function createPendingImport({ rows, preview, actorDiscordId }) {
  const token = randomUUID();
  pendingImports.set(token, {
    token,
    rows,
    preview,
    actorDiscordId,
    used: false,
    expiresAt: Date.now() + TTL,
  });
  return token;
}

export function consumePendingImport(token, actorDiscordId) {
  const entry = pendingImports.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pendingImports.delete(token);
    return null;
  }
  if (entry.actorDiscordId !== actorDiscordId) return { forbidden: true };
  if (entry.used) return { duplicate: true };
  entry.used = true;
  pendingImports.delete(token);
  return entry;
}

export function cancelPendingImport(token, actorDiscordId) {
  const entry = pendingImports.get(token);
  if (!entry || entry.actorDiscordId !== actorDiscordId) return false;
  pendingImports.delete(token);
  return true;
}
