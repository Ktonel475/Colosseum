/**
 * Monospace table rendering for Discord.
 *
 * Discord does not render Markdown pipe tables, so every table is emitted as
 * plain text inside a triple-backtick code block. Column widths come from the
 * longest cell (including the header) and cells are left-aligned.
 *
 * Note: width is measured in code points, not terminal cells. Thai/CJK glyphs
 * and emoji can be wider than a Latin character, so mixed-script tables may
 * drift slightly; prefer short labels in those columns.
 */

const PLAIN_LIMIT = 1900;

export function cellLength(value) {
  return Array.from(String(value ?? '')).length;
}

function normalizeCell(value) {
  // Newlines break table rows and backticks can terminate the code fence.
  return String(value ?? '')
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ');
}

export function computeWidths(headers, rows) {
  return headers.map((header, index) => {
    const cells = [header, ...rows.map((row) => row[index])];
    return Math.max(1, ...cells.map((cell) => cellLength(normalizeCell(cell))));
  });
}

function pad(value, width) {
  const text = normalizeCell(value);
  return text + ' '.repeat(Math.max(0, width - cellLength(text)));
}

function dividerLine(widths) {
  if (widths.length === 1) return '-'.repeat(widths[0]);
  const segments = widths.map((width, index) => {
    if (index === 0) return width + 1;
    if (index === widths.length - 1) return width + 1;
    return width + 2;
  });
  return segments.map((length) => '-'.repeat(length)).join('|');
}

function headerLines(headers, widths) {
  const header = headers.map((h, i) => pad(h, widths[i])).join(' | ');
  return [header, dividerLine(widths)];
}

function rowLine(row, widths) {
  return widths.map((width, index) => pad(row[index], width)).join(' | ');
}

/**
 * Render a single fenced table. Not intended for very large row sets — use
 * `formatTableMessages` when the table may exceed Discord's message limit.
 */
export function formatTable(headers, rows) {
  const widths = computeWidths(headers, rows);
  const lines = [...headerLines(headers, widths), ...rows.map((row) => rowLine(row, widths))];
  return '```\n' + lines.join('\n') + '\n```';
}

/**
 * Render a table as one or more fenced messages, repeating the header on each
 * message. Widths are computed across the whole table so every chunk is
 * aligned consistently.
 *
 * @returns {string[]} message payload strings, each within `limit` characters.
 */
export function formatTableMessages(headers, rows, limit = PLAIN_LIMIT) {
  const widths = computeWidths(headers, rows);
  const head = headerLines(headers, widths);
  const dataLines = rows.map((row) => rowLine(row, widths));

  const overhead = '```\n'.length + '\n```'.length;
  const headLength = head.reduce((sum, line) => sum + 1 + line.length, 0);
  const blocks = [];
  let current = [...head];
  let currentLength = overhead + headLength;

  const flush = () => {
    blocks.push('```\n' + current.join('\n') + '\n```');
  };

  for (const line of dataLines) {
    const cost = 1 + line.length;
    if (current.length > head.length && currentLength + cost > limit) {
      flush();
      current = [...head];
      currentLength = overhead + headLength;
    }
    current.push(line);
    currentLength += cost;
  }
  flush();
  return blocks;
}

const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

export function containsWideChars(values) {
  return values.some((value) => WIDE_CHAR.test(String(value ?? '')));
}

export default {
  formatTable,
  formatTableMessages,
  computeWidths,
  containsWideChars,
  cellLength,
};
