/**
 * Extractable match module.
 *
 * Public surface used by the host bot:
 *   matchCommandDefinitions  SlashCommandBuilder[] to merge into the registry
 *   matchCommandNames        Set of command names dispatched to this module
 *   handleMatchCommand       command handler
 *   handleMatchComponent     select/button handler for `matchmod:` custom IDs
 *   isMatchComponentId       customId prefix check
 *
 * Nothing here imports the host registry, `/init`, player registration or
 * onboarding code. Storage is accessed only through ./repository.
 */
export { matchCommandDefinitions, matchCommandNames } from './commands.js';
export { handleMatchCommand, handleMatchComponent } from './handlers.js';
export { isMatchComponentId, CUSTOM_ID_PREFIX } from './ui.js';
export { t, resolveLocale } from '../../utils/i18n.js';
export { createRepository } from './repository/index.js';

export default {};
