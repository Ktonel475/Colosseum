import prisma from '../database/prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
  resolveLocale,
} from '../utils/i18n.js';

/**
 * Per-user language preference.
 *
 * Resolution order:
 *   1. the locale the user saved with `/language`
 *   2. the Discord client locale supplied by the interaction (`interaction.locale`)
 *   3. English
 *
 * Only English (`en`) and Thai (`th`) are supported.
 */

export const LANGUAGE_CHOICES = Object.freeze([
  { name: 'English', value: 'en' },
  { name: 'ไทย (Thai)', value: 'th' },
]);

/** True when the value is a supported explicit locale (`en` / `th`). */
export function isSupportedLocale(locale) {
  return Boolean(normalizeLocale(locale));
}

/** Read only the saved preference; returns null when the user has not chosen. */
export async function getStoredLocale(discordUserId, client = prisma) {
  if (!discordUserId) return null;
  const row = await client.user_settings.findUnique({
    where: { discord_user_id: String(discordUserId) },
  });
  return normalizeLocale(row?.locale) ?? null;
}

/** Save an explicit language choice. Throws for unsupported values. */
export async function setUserLocale(discordUserId, locale, client = prisma) {
  const normalized = normalizeLocale(locale);
  if (!normalized) {
    throw new ValidationError(`Unsupported locale: ${locale}`, undefined, {
      i18nKey: 'errors.unsupported_locale',
      i18nParams: { supported: SUPPORTED_LOCALES.join(', ') },
    });
  }
  if (!discordUserId) {
    throw new ValidationError('A Discord user id is required', undefined, {
      i18nKey: 'errors.user_required',
    });
  }

  return client.user_settings.upsert({
    where: { discord_user_id: String(discordUserId) },
    update: { locale: normalized },
    create: { discord_user_id: String(discordUserId), locale: normalized },
  });
}

/**
 * Resolve a user's effective locale, falling back to the Discord client
 * preference and finally English.
 */
export async function getUserLocale(discordUserId, clientLocale, client = prisma) {
  const stored = await getStoredLocale(discordUserId, client);
  return stored ?? resolveLocale(clientLocale) ?? FALLBACK_LOCALE;
}

/**
 * Resolve the locale for an interaction. A failure to read the preference must
 * never block the command, so database errors fall back to the client locale.
 */
export async function resolveInteractionLocale(interaction, client = prisma) {
  try {
    return await getUserLocale(interaction?.user?.id, interaction?.locale, client);
  } catch (err) {
    logger.warn({ err, user: interaction?.user?.id }, 'Could not read language preference');
    return resolveLocale(interaction?.locale);
  }
}

export default {
  LANGUAGE_CHOICES,
  isSupportedLocale,
  getStoredLocale,
  setUserLocale,
  getUserLocale,
  resolveInteractionLocale,
};
