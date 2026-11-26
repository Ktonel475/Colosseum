import prisma from '../database/prisma.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { ValidationError, ConflictError, NotFoundError, AppError } from '../utils/errors.js';
import { t } from '../utils/i18n.js';
import { recordAudit } from './auditService.js';

const INTEGER = /^\d+$/;

export function parseScore(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError('Scores must be non-negative integers', undefined, {
        i18nKey: 'errors.scores_invalid',
      });
    }
    return value;
  }
  if (typeof value !== 'string' || !INTEGER.test(value.trim())) {
    throw new ValidationError('Scores must be non-negative integers', undefined, {
      i18nKey: 'errors.scores_invalid',
    });
  }
  return Number(value.trim());
}

export async function getResultById(resultId, client = prisma) {
  return client.results.findUnique({
    where: { id: resultId },
    include: {
      confirmations: true,
      match: { include: { team1: true, team2: true } },
      submittedByUser: true,
    },
  });
}

export async function getResultByMatch(matchId, client = prisma) {
  return client.results.findFirst({
    where: { match_id: matchId },
    include: { confirmations: true, match: { include: { team1: true, team2: true } } },
    orderBy: { submitted_at: 'desc' },
  });
}

export async function listResults({ status, matchId, submittedBy } = {}) {
  const where = {};
  if (status) where.status = status;
  if (matchId) where.match_id = matchId;
  if (submittedBy) where.submitted_by = submittedBy;
  return prisma.results.findMany({
    where,
    include: {
      match: { include: { team1: true, team2: true } },
      confirmations: true,
      submittedByUser: true,
    },
    orderBy: { submitted_at: 'desc' },
  });
}

/**
 * Submit a result from within a match thread.
 */
export async function submitResult({
  threadId,
  discordUserId,
  score1,
  score2,
  policy = config.resultConfirmationPolicy,
}) {
  if (!threadId) {
    throw new ValidationError('This command must be used inside a match thread', undefined, {
      i18nKey: 'errors.thread_required',
    });
  }

  const match = await prisma.matches.findUnique({
    where: { discord_thread_id: threadId },
    include: { team1: true, team2: true },
  });
  if (!match) {
    throw new ValidationError('This thread is not associated with a match', undefined, {
      i18nKey: 'errors.thread_not_match',
    });
  }
  if (match.status !== 'active') {
    throw new ConflictError('This match is closed', { i18nKey: 'errors.match_closed' });
  }

  const player = await prisma.players.findUnique({ where: { discord_user_id: discordUserId } });
  if (!player) {
    throw new ValidationError('You are not registered', undefined, {
      i18nKey: 'errors.player_not_registered',
    });
  }
  if (player.team_id !== match.team1_id && player.team_id !== match.team2_id) {
    throw new ValidationError('You do not belong to either participating team', undefined, {
      i18nKey: 'errors.not_participating_team',
    });
  }

  const s1 = parseScore(score1);
  const s2 = parseScore(score2);

  const existing = await prisma.results.findFirst({
    where: { match_id: match.id, status: { in: ['pending', 'final'] } },
  });
  if (existing) {
    throw new ConflictError('A result has already been submitted for this match', {
      i18nKey: 'errors.result_already_submitted',
    });
  }

  const result = await prisma.results.create({
    data: {
      match_id: match.id,
      score1: s1,
      score2: s2,
      submitted_by: discordUserId,
      status: policy === 'automatic' ? 'final' : 'pending',
      confirmed_at: policy === 'automatic' ? new Date() : null,
    },
  });

  await recordAudit({
    actorDiscordId: discordUserId,
    action: 'RESULT_SUBMIT',
    entityType: 'result',
    entityId: result.id,
    newValue: {
      match_id: match.id,
      score1: s1,
      score2: s2,
      policy,
      status: result.status,
    },
  });

  logger.info({ resultId: result.id, matchId: match.id, s1, s2, policy }, 'Result submitted');
  return { result, match, policy };
}

/**
 * Record a confirmation from a participant and finalize when the policy is met.
 */
export async function confirmResult({ resultId, discordUserId, policy = config.resultConfirmationPolicy }) {
  const result = await prisma.results.findUnique({
    where: { id: resultId },
    include: { match: true, confirmations: true },
  });
  if (!result) {
    throw new NotFoundError('Result not found', { i18nKey: 'errors.result_not_found' });
  }
  if (result.status === 'final') {
    throw new ConflictError('Result is already final', { i18nKey: 'errors.result_already_final' });
  }
  if (result.status === 'cancelled') {
    throw new ConflictError('Result was cancelled', { i18nKey: 'errors.result_cancelled' });
  }
  if (policy === 'automatic') {
    throw new ValidationError('This policy confirms results automatically', undefined, {
      i18nKey: 'errors.automatic_policy',
    });
  }

  const player = await prisma.players.findUnique({ where: { discord_user_id: discordUserId } });
  if (!player) {
    throw new ValidationError('You are not registered', undefined, {
      i18nKey: 'errors.player_not_registered',
    });
  }
  if (player.team_id !== result.match.team1_id && player.team_id !== result.match.team2_id) {
    throw new ValidationError('You do not belong to either participating team', undefined, {
      i18nKey: 'errors.not_participating_team',
    });
  }

  const duplicate = await prisma.result_confirmations.findFirst({
    where: { result_id: resultId, discord_user_id: discordUserId },
  });
  if (duplicate) {
    throw new ConflictError('You have already confirmed this result', {
      i18nKey: 'errors.result_already_confirmed',
    });
  }

  await prisma.result_confirmations.create({
    data: {
      result_id: resultId,
      discord_user_id: discordUserId,
      confirmation_status: 'confirmed',
    },
  });

  const finalized = await evaluateConfirmation(resultId, { policy });
  return finalized;
}

/**
 * Administrator confirmation (used when policy === 'administrator').
 */
export async function adminConfirmResult({ resultId, actorDiscordId, policy = config.resultConfirmationPolicy }) {
  const result = await prisma.results.findUnique({
    where: { id: resultId },
    include: { match: true },
  });
  if (!result) {
    throw new NotFoundError('Result not found', { i18nKey: 'errors.result_not_found' });
  }
  if (result.status === 'final') {
    throw new ConflictError('Result is already final', { i18nKey: 'errors.result_already_final' });
  }
  if (result.status === 'cancelled') {
    throw new ConflictError('Result was cancelled', { i18nKey: 'errors.result_cancelled' });
  }

  const existing = await prisma.result_confirmations.findFirst({
    where: { result_id: resultId, discord_user_id: actorDiscordId },
  });
  if (!existing) {
    await prisma.result_confirmations.create({
      data: {
        result_id: resultId,
        discord_user_id: actorDiscordId,
        confirmation_status: 'confirmed',
        notes: 'administrator',
      },
    });
  }

  if (policy === 'both_teams') {
    // Admin confirmation does not bypass participant confirmation.
    return evaluateConfirmation(resultId, { policy });
  }

  return finalizeResult(resultId, actorDiscordId);
}

async function evaluateConfirmation(resultId, { policy }) {
  const result = await prisma.results.findUnique({
    where: { id: resultId },
    include: { match: true, confirmations: true },
  });
  if (!result) {
    throw new NotFoundError('Result not found', { i18nKey: 'errors.result_not_found' });
  }

  if (policy === 'administrator') {
    const adminConfirm = result.confirmations.find((c) => c.notes === 'administrator');
    if (adminConfirm) return finalizeResult(resultId, adminConfirm.discord_user_id);
    return { ...result, status: 'pending' };
  }

  // both_teams: need at least one confirmation from each participating team.
  const confirmerIds = result.confirmations
    .filter((c) => c.confirmation_status === 'confirmed')
    .map((c) => c.discord_user_id);

  const players = confirmerIds.length
    ? await prisma.players.findMany({ where: { discord_user_id: { in: confirmerIds } } })
    : [];

  const teamsConfirmed = new Set(players.map((p) => p.team_id));
  const needsTeam1 = teamsConfirmed.has(result.match.team1_id);
  const needsTeam2 = teamsConfirmed.has(result.match.team2_id);

  if (needsTeam1 && needsTeam2) {
    return finalizeResult(resultId, confirmerIds[0] ?? 'system');
  }

  return { ...result, status: 'pending', teamsConfirmed: [...teamsConfirmed] };
}

async function finalizeResult(resultId, actorDiscordId) {
  const updated = await prisma.results.update({
    where: { id: resultId },
    data: { status: 'final', confirmed_at: new Date() },
  });
  await recordAudit({
    actorDiscordId,
    action: 'RESULT_FINALIZE',
    entityType: 'result',
    entityId: resultId,
    newValue: { status: 'final' },
  });
  return updated;
}

export async function editResult({ resultId, score1, score2, actorDiscordId }) {
  const result = await prisma.results.findUnique({ where: { id: resultId } });
  if (!result) {
    throw new NotFoundError('Result not found', { i18nKey: 'errors.result_not_found' });
  }

  const s1 = parseScore(score1);
  const s2 = parseScore(score2);

  const updated = await prisma.results.update({
    where: { id: resultId },
    data: { score1: s1, score2: s2 },
  });

  await recordAudit({
    actorDiscordId,
    action: 'RESULT_EDIT',
    entityType: 'result',
    entityId: resultId,
    previousValue: { score1: result.score1, score2: result.score2, status: result.status },
    newValue: { score1: s1, score2: s2, status: updated.status },
  });

  return updated;
}

export async function cancelResult({ resultId, actorDiscordId, isAdmin = false, requesterId }) {
  const result = await prisma.results.findUnique({ where: { id: resultId } });
  if (!result) {
    throw new NotFoundError('Result not found', { i18nKey: 'errors.result_not_found' });
  }
  if (result.status === 'final') {
    throw new ConflictError('Final results cannot be cancelled', {
      i18nKey: 'errors.final_result_not_cancellable',
    });
  }
  if (result.status === 'cancelled') {
    throw new ConflictError('Result is already cancelled', {
      i18nKey: 'errors.result_already_cancelled',
    });
  }
  if (!isAdmin && result.submitted_by !== requesterId) {
    throw new AppError('You cannot cancel this submission', {
      status: 403,
      code: 'FORBIDDEN',
      i18nKey: 'errors.cannot_cancel_submission',
    });
  }

  const updated = await prisma.results.update({
    where: { id: resultId },
    data: { status: 'cancelled' },
  });

  await prisma.result_confirmations.updateMany({
    where: { result_id: resultId },
    data: { confirmation_status: 'cancelled' },
  });

  await recordAudit({
    actorDiscordId,
    action: 'RESULT_CANCEL',
    entityType: 'result',
    entityId: resultId,
    previousValue: { status: result.status },
    newValue: { status: 'cancelled' },
  });

  return updated;
}

/**
 * Return a human-readable summary of remaining confirmations.
 *
 * @param {string} resultId
 * @param {string} [policy]
 * @param {string} [locale] user locale for the returned text (defaults to English)
 */
export async function describeConfirmationStatus(
  resultId,
  policy = config.resultConfirmationPolicy,
  locale = 'en',
) {
  if (policy === 'automatic') return t(locale, 'result_status.automatic');
  if (policy === 'administrator') return t(locale, 'result_status.administrator');
  const result = await prisma.results.findUnique({
    where: { id: resultId },
    include: { match: true, confirmations: true },
  });
  if (!result) return t(locale, 'result_status.unknown');
  const confirmerIds = result.confirmations
    .filter((c) => c.confirmation_status === 'confirmed')
    .map((c) => c.discord_user_id);
  const players = confirmerIds.length
    ? await prisma.players.findMany({ where: { discord_user_id: { in: confirmerIds } } })
    : [];
  const teams = new Set(players.map((p) => p.team_id));
  const need1 = !teams.has(result.match.team1_id);
  const need2 = !teams.has(result.match.team2_id);
  if (!need1 && !need2) return t(locale, 'result_status.all_received');
  const missing = [need1 ? result.match.team1_id : null, need2 ? result.match.team2_id : null].filter(Boolean);
  const teamNames = await prisma.teams.findMany({ where: { team_id: { in: missing } } });
  return t(locale, 'result_status.awaiting', {
    teams: teamNames.map((team) => team.team_name).join(', '),
  });
}

export default {
  parseScore,
  getResultById,
  getResultByMatch,
  listResults,
  submitResult,
  confirmResult,
  adminConfirmResult,
  editResult,
  cancelResult,
  describeConfirmationStatus,
};
