import {
  createPendingSelection,
  consumePendingSelection,
  cancelPendingSelection,
} from '../src/bot/interactions/state.js';

describe('pending team confirmations', () => {
  test('a token can only be consumed once (duplicate click protection)', () => {
    const token = createPendingSelection({ discordUserId: 'u1', teamId: 'team1', guildId: 'g1' });
    expect(consumePendingSelection(token, 'u1')).toMatchObject({ teamId: 'team1' });
    expect(consumePendingSelection(token, 'u1')).toEqual({ duplicate: true });
  });

  test('tokens are bound to their owner', () => {
    const token = createPendingSelection({ discordUserId: 'u1', teamId: 'team1', guildId: 'g1' });
    expect(consumePendingSelection(token, 'u2')).toEqual({ forbidden: true });
  });

  test('cancelling prevents any assignment', () => {
    const token = createPendingSelection({ discordUserId: 'u1', teamId: 'team1', guildId: 'g1' });
    expect(cancelPendingSelection(token, 'u1')).toBe(true);
    expect(consumePendingSelection(token, 'u1')).toBeNull();
  });

  test('unknown token is rejected', () => {
    expect(consumePendingSelection('does-not-exist', 'u1')).toBeNull();
  });
});
