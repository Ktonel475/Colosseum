import { splitMessage, SAFE_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT } from '../src/utils/message.js';

describe('splitMessage', () => {
  test('returns short content unchanged', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  test('returns nothing for empty content', () => {
    expect(splitMessage('')).toEqual([]);
    expect(splitMessage(null)).toEqual([]);
  });

  test('splits long content on newlines and respects the limit', () => {
    const line = 'x'.repeat(200);
    const text = Array.from({ length: 30 }, (_, i) => `${i} ${line}`).join('\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SAFE_MESSAGE_LIMIT);
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
    expect(chunks.join('\n')).toBe(text);
  });

  test('hard-cuts content without whitespace', () => {
    const text = 'a'.repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks).toEqual(['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(10)]);
  });

  test('prefers spaces when no newline is available', () => {
    const text = 'word '.repeat(20).trim();
    const chunks = splitMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30);
    expect(chunks.join(' ')).toBe(text);
  });
});
