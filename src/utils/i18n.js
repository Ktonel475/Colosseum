import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Project-wide i18n utility.
 *
 * Locale dictionaries live in `src/locales/{en,th}.json`. Keys are namespaced
 * by feature, e.g. `match.thread_name_template`. Every user-facing string in
 * the project should go through `t()` (or a namespaced translator created with
 * `createTranslator()`), never through hard-coded literals.
 *
 * Dictionaries are loaded eagerly at import time so `t()` is synchronous and
 * safe to call from any handler. `preloadLocales()` remains available for
 * callers that want to wait explicitly during bootstrap.
 */

const SUPPORTED_LOCALES = Object.freeze(['en', 'th']);
const FALLBACK_LOCALE = 'en';

const dictionaries = {};

function localePath(locale) {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(baseDir, '..', 'locales', `${locale}.json`);
}

function loadDictionary(locale) {
  if (dictionaries[locale]) return dictionaries[locale];
  const json = readFileSync(localePath(locale), 'utf8');
  const dict = JSON.parse(json);
  dictionaries[locale] = dict;
  return dict;
}

// Load every supported locale eagerly; t() must never depend on async timing.
for (const locale of SUPPORTED_LOCALES) loadDictionary(locale);

/**
 * Preload all supported locales. Kept for bootstrap code and tests; loading is
 * already done at import time, so this simply resolves.
 *
 * @returns {Promise<void>}
 */
export async function preloadLocales() {
  for (const locale of SUPPORTED_LOCALES) loadDictionary(locale);
}

/**
 * Resolve a Discord locale (`th`, `th-TH`, `en-US`, ...) to a supported
 * dictionary. Anything that is not Thai falls back to English.
 *
 * @param {string} [locale]
 * @returns {'en' | 'th'}
 */
export function resolveLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('th') ? 'th' : FALLBACK_LOCALE;
}

/**
 * Normalize an explicit language choice. Unlike {@link resolveLocale}, an
 * unsupported value returns `null` so callers can reject it instead of silently
 * falling back to English.
 *
 * @param {string} [locale]
 * @returns {'en' | 'th' | null}
 */
export function normalizeLocale(locale) {
  const value = String(locale ?? '').toLowerCase();
  if (value === 'en' || value.startsWith('en-')) return 'en';
  if (value === 'th' || value.startsWith('th-')) return 'th';
  return null;
}

/**
 * Locale for an interaction. The host sets `interaction.userLocale` after
 * reading the stored user preference; when it is absent (e.g. the match module
 * used standalone) we fall back to the Discord client locale.
 *
 * @param {object} interaction
 * @returns {'en' | 'th'}
 */
export function interactionLocale(interaction) {
  return resolveLocale(interaction?.userLocale ?? interaction?.locale);
}

/** Translate using an interaction's resolved user locale. */
export function tUser(interaction, key, params) {
  return t(interactionLocale(interaction), key, params);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/**
 * Translate a key. Missing keys fall back to English, then to the key itself.
 *
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(locale, key, params = {}) {
  const lang = resolveLocale(locale);
  const dict = dictionaries[lang] ?? dictionaries[FALLBACK_LOCALE] ?? {};
  const fallback = dictionaries[FALLBACK_LOCALE] ?? {};
  const template = dict[key] ?? fallback[key] ?? key;
  return interpolate(template, params);
}

/**
 * Build a translator bound to a key namespace. The match module, for example,
 * stores keys as `match.*` and consumes them through `createTranslator('match')`
 * so call sites stay short while the implementation remains project-wide.
 *
 * @param {string} [namespace]
 * @returns {(locale: string, key: string, params?: Record<string, unknown>) => string}
 */
export function createTranslator(namespace) {
  const prefix = namespace ? `${String(namespace).replace(/\.+$/, '')}.` : '';
  return (locale, key, params) => t(locale, `${prefix}${key}`, params);
}

/** Interaction helper that prefers the stored user locale, then `interaction.locale`. */
export function tInteraction(interaction, key, params) {
  return tUser(interaction, key, params);
}

/** Namespaced translator for the match module. */
export const tMatch = createTranslator('match');

/** All loaded dictionaries (for testing/inspection). */
export { dictionaries, SUPPORTED_LOCALES, FALLBACK_LOCALE };

export default {
  t,
  tMatch,
  tInteraction,
  tUser,
  interactionLocale,
  createTranslator,
  resolveLocale,
  normalizeLocale,
  preloadLocales,
  dictionaries,
};
