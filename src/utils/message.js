export const DISCORD_MESSAGE_LIMIT = 2000;
// Leave room for formatting/mentions so a chunk never trips Discord's limit.
export const SAFE_MESSAGE_LIMIT = 1900;

/**
 * Split text into chunks that fit within a Discord message. Prefers breaking on
 * newlines, then spaces, and only hard-cuts when no boundary is available.
 *
 * @param {string} text
 * @param {number} [limit=SAFE_MESSAGE_LIMIT]
 * @returns {string[]}
 */
export function splitMessage(text, limit = SAFE_MESSAGE_LIMIT) {
  const str = String(text ?? '');
  if (!str) return [];
  if (limit < 1) throw new Error('limit must be a positive number');
  if (str.length <= limit) return [str];

  const chunks = [];
  let remaining = str;
  const minBoundary = Math.floor(limit * 0.5);

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < minBoundary) cut = remaining.lastIndexOf(' ', limit);
    if (cut < minBoundary) cut = limit;

    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export default { DISCORD_MESSAGE_LIMIT, SAFE_MESSAGE_LIMIT, splitMessage };
