import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dictionaries = {};

/**
 * Load a locale dictionary from src/locales/{locale}.json.
 *
 * @param {string} locale - 'en' or 'th'
 * @returns {Promise<Record<string, string>>}
 */
async function loadDictionary(locale) {
  if (dictionaries[locale]) return dictionaries[locale];

  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(baseDir, '..', 'locales', `${locale}.json`);
  const json = await readFile(filePath, 'utf8');
  const dict = JSON.parse(json);
  dictionaries[locale] = dict;
  return dict;
}

/**
 * Preload all known locales. Call from bootstrap before handling interactions.
 * @returns {Promise<void>}
 */
export async function preloadLocales() {
  await Promise.all(['en', 'th'].map(loadDictionary));
}

/**
 * Resolve a Discord locale (`th`, `th-TH`, `en-US`, ...) to a supported
 * dictionary. Anything that is not Thai falls back to English.
 *
 * @param {string} [locale]
 * @returns {'en' | 'th'}
 */
export function resolveLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('th') ? 'th' : 'en';
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
  const dict = dictionaries[lang] ?? dictionaries.en ?? {};
  const template = dict[key] ?? dictionaries.en[key] ?? key;
  return interpolate(template, params);
}

/** Interaction helper that reads `interaction.locale`. */
export function tInteraction(interaction, key, params) {
  return t(interaction?.locale, key, params);
}

/** All loaded dictionaries (for testing/inspection). */
export { dictionaries };

export default { t, tInteraction, resolveLocale, preloadLocales, dictionaries };