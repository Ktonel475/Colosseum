import {
  formatTable,
  formatTableMessages,
  computeWidths,
  containsWideChars,
} from '../src/utils/table.js';

describe('formatTable', () => {
  test('computes widths and renders an aligned monospace table', () => {
    const table = formatTable(
      ['Name', 'Role', 'Status'],
      [
        ['Alice', 'Admin', 'Online'],
        ['Bob', 'Member', 'Offline'],
      ],
    );

    expect(table).toBe(
      [
        '```',
        'Name  | Role   | Status ',
        '------|--------|--------',
        'Alice | Admin  | Online ',
        'Bob   | Member | Offline',
        '```',
      ].join('\n'),
    );
  });

  test('pads columns from the longest cell, including the header', () => {
    const widths = computeWidths(['Code', 'Team'], [['T1', 'A much longer name']]);
    expect(widths).toEqual([4, 18]);
  });

  test('sanitizes newlines and backticks inside cells', () => {
    const table = formatTable(['A'], [['line1\nline2`tick']]);
    expect(table).toContain('line1 line2\'tick');
    expect((table.match(/```/g) ?? []).length).toBe(2);
  });

  test('detects wide characters for the alignment note', () => {
    expect(containsWideChars(['ทีมไทย'])).toBe(false); // Thai is not full-width
    expect(containsWideChars(['チーム'])).toBe(true);
    expect(containsWideChars(['🔥'])).toBe(true);
  });
});

describe('formatTableMessages', () => {
  test('splits large tables into aligned fenced messages', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`Team ${i}`, `T${i}`, 'RoV']);
    const messages = formatTableMessages(['Name', 'Code', 'Game type'], rows, 300);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(300);
      expect(message.startsWith('```\n')).toBe(true);
      expect(message.endsWith('\n```')).toBe(true);
      expect(message).toContain('Name');
      expect(message).toContain('---');
    }
    const joined = messages.join('\n');
    for (const row of rows) expect(joined).toContain(row[0]);
    expect(joined).toContain('Team 39');
  });

  test('keeps every message under the default Discord-safe limit', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [
      `A fairly long team name number ${i}`,
      `TEAM-CODE-${i}`,
      'Mobile Legends',
    ]);
    const messages = formatTableMessages(['Name', 'Code', 'Game type'], rows);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(1900);
    }
  });
});
