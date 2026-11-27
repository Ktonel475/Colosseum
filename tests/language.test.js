import prisma from '../src/database/prisma.js';
import { resetDb } from './helpers.js';
import {
  normalizeLocale,
  interactionLocale,
  t,
  tUser,
  SUPPORTED_LOCALES,
} from '../src/utils/i18n.js';
import {
  LANGUAGE_CHOICES,
  getStoredLocale,
  getUserLocale,
  isSupportedLocale,
  resolveInteractionLocale,
  setUserLocale,
} from '../src/services/languageService.js';
import { handleInteraction } from '../src/bot/interactions/index.js';
import { sendWelcome } from '../src/bot/welcome.js';
import { commandDefinitions } from '../src/bot/registerCommands.js';

beforeEach(resetDb);
afterAll(async () => prisma.$disconnect());

describe('language support', () => {
  test('supports exactly Thai and English', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'th']);
    expect(LANGUAGE_CHOICES.map((choice) => choice.value)).toEqual(['en', 'th']);
    expect(normalizeLocale('th-TH')).toBe('th');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
    expect(isSupportedLocale('th')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });

  test('registers a /language command with English and Thai choices', () => {
    const command = commandDefinitions.find((c) => c.name === 'language');
    expect(command).toBeDefined();
    const option = command.toJSON().options[0];
    expect(option.name).toBe('language');
    expect(option.required).toBe(true);
    expect(option.choices.map((choice) => choice.value)).toEqual(['en', 'th']);
  });

  test('persists a per-user language preference', async () => {
    expect(await getStoredLocale('user-1')).toBeNull();
    await setUserLocale('user-1', 'th');
    expect(await getStoredLocale('user-1')).toBe('th');
    await setUserLocale('user-1', 'en');
    expect(await getStoredLocale('user-1')).toBe('en');
  });

  test('rejects unsupported explicit locales', async () => {
    await expect(setUserLocale('user-1', 'fr')).rejects.toMatchObject({
      i18nKey: 'errors.unsupported_locale',
    });
  });

  test('prefers the saved locale over the Discord client locale', async () => {
    await setUserLocale('user-1', 'th');
    expect(await getUserLocale('user-1', 'en-US')).toBe('th');
    expect(await getUserLocale('user-2', 'th-TH')).toBe('th');
    expect(await getUserLocale('user-2', 'en-US')).toBe('en');
  });

  test('interaction helpers prefer the resolved user locale', async () => {
    const interaction = { user: { id: 'user-1' }, locale: 'en-US' };
    expect(interactionLocale(interaction)).toBe('en');
    interaction.userLocale = 'th';
    expect(interactionLocale(interaction)).toBe('th');
    expect(tUser(interaction, 'common.cancel')).toBe(t('th', 'common.cancel'));

    await setUserLocale('user-1', 'th');
    expect(await resolveInteractionLocale(interaction)).toBe('th');
  });

  test('falls back to the client locale when the preference cannot be read', async () => {
    const interaction = {
      user: { id: 'user-1' },
      locale: 'th-TH',
    };
    expect(await resolveInteractionLocale(interaction, {})).toBe('th');
  });
});

function makeInteraction({ locale = 'en-US', language = 'th' } = {}) {
  const state = { replies: [], deferred: false, replied: false };
  const interaction = {
    commandName: 'language',
    locale,
    user: { id: 'language-user', username: 'language-user' },
    member: null,
    guild: null,
    options: { getString: (name) => (name === 'language' ? language : null) },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
  };
  interaction.reply = async (payload) => {
    state.replied = true;
    state.replies.push(payload);
  };
  interaction.editReply = async (payload) => {
    state.replied = true;
    state.replies.push(payload);
  };
  interaction.followUp = async (payload) => state.replies.push(payload);
  interaction.deferReply = async () => {
    state.deferred = true;
  };
  state.interaction = interaction;
  return state;
}

describe('/language command', () => {
  test('saves the choice and answers in the selected language', async () => {
    const state = makeInteraction({ locale: 'en-US', language: 'th' });

    await handleInteraction(state.interaction, { client: {} });

    expect(await getStoredLocale('language-user')).toBe('th');
    expect(state.replies[0].content).toBe(
      t('th', 'bot.language.saved', { language: t('th', 'language.th') }),
    );
    expect(state.interaction.userLocale).toBe('th');
  });

  test('an explicit choice overrides the previously saved preference', async () => {
    await setUserLocale('language-user', 'th');
    const state = makeInteraction({ locale: 'en-US', language: 'en' });

    await handleInteraction(state.interaction, { client: {} });

    expect(await getStoredLocale('language-user')).toBe('en');
    expect(state.interaction.userLocale).toBe('en');
    expect(state.replies[0].content).toBe(
      t('en', 'bot.language.saved', { language: t('en', 'language.en') }),
    );
  });
});

describe('welcome message language', () => {
  test('uses the saved user preference', async () => {
    await setUserLocale('welcome-user', 'th');
    const sent = [];
    const user = {
      id: 'welcome-user',
      username: 'welcome',
      send: async (payload) => sent.push(payload),
    };

    await sendWelcome(user, 'guild-1');

    expect(sent[0].embeds[0].data.title).toBe(t('th', 'welcome.title'));
    expect(sent[0].components[0].components[0].data.label).toBe(
      t('th', 'welcome.choose_team'),
    );
  });
});
