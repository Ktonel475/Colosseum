import { randomUUID } from 'node:crypto';
import config from '../../config/index.js';

const TTL = config.interactionExpiration;

const bulkSessions = new Map();
const resultConfirmations = new Map();

function sweep(map) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

setInterval(() => {
  sweep(bulkSessions);
  sweep(resultConfirmations);
}, Math.min(TTL, 60_000)).unref?.();

/* ------------------------------- bulk ----------------------------------- */

export function createBulkSession({ userId, channelId }) {
  const token = randomUUID();
  bulkSessions.set(token, {
    token,
    userId,
    channelId,
    pairs: [],
    pending: { team1: null, team2: null },
    notice: null,
    expiresAt: Date.now() + TTL,
  });
  return token;
}

export function getBulkSession(token) {
  const entry = bulkSessions.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    bulkSessions.delete(token);
    return null;
  }
  return entry;
}

export function deleteBulkSession(token) {
  return bulkSessions.delete(token);
}

/* ---------------------------- result confirm ----------------------------- */

export function createResultConfirmation({ threadId, winner, requesterId, team1Name, team2Name }) {
  const token = randomUUID();
  resultConfirmations.set(token, {
    token,
    threadId,
    winner,
    requesterId,
    team1Name,
    team2Name,
    expiresAt: Date.now() + TTL,
  });
  return token;
}

export function takeResultConfirmation(token, userId) {
  const entry = resultConfirmations.get(token);
  if (!entry) return { error: 'expired' };
  if (entry.expiresAt <= Date.now()) {
    resultConfirmations.delete(token);
    return { error: 'expired' };
  }
  if (entry.requesterId !== userId) return { error: 'forbidden' };
  resultConfirmations.delete(token);
  return { entry };
}

export function peekResultConfirmation(token) {
  const entry = resultConfirmations.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    resultConfirmations.delete(token);
    return null;
  }
  return entry;
}

export function deleteResultConfirmation(token) {
  return resultConfirmations.delete(token);
}

export default {
  createBulkSession,
  getBulkSession,
  deleteBulkSession,
  createResultConfirmation,
  takeResultConfirmation,
  peekResultConfirmation,
  deleteResultConfirmation,
};
