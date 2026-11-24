import { readFileSync } from 'node:fs';

const dictionaries = {
  en: JSON.parse(readFileSync(new URL('./locales/en.json', import.meta.url), 'utf8')),
  th: JSON.parse(readFileSync(new URL('./locales/th.json', import.meta.url), 'utf8')),
};

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
  const template = dictionaries[lang]?.[key] ?? dictionaries.en[key] ?? key;
  return interpolate(template, params);
}

/** Interaction helper that reads `interaction.locale`. */
export function tInteraction(interaction, key, params) {
  return t(interaction?.locale, key, params);
}

export { dictionaries };
export default { t, tInteraction, resolveLocale, dictionaries };
