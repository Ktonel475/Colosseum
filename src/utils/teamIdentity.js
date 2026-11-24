/**
 * Team names are only unique within a competition category (game type).
 * The same school may enter the same team name in several categories, so
 * identity is the pair (team_name, game_type), while `team_id` (รหัสทีม)
 * remains the globally unique primary key.
 */
export function normalizeGameType(value) {
  const v = (value ?? '').toString().trim();
  return v.length ? v : null;
}

/** Case-insensitive key for name + game type. */
export function teamNameKey(teamName, gameType) {
  const name = (teamName ?? '').toString().trim().toLowerCase();
  const game = (normalizeGameType(gameType) ?? '').toLowerCase();
  return `${name}::${game}`;
}

/** Human-readable category label, for error messages. */
export function describeCategory(gameType) {
  const game = normalizeGameType(gameType);
  return game ? `game type '${game}'` : 'no game type';
}

export default { normalizeGameType, teamNameKey, describeCategory };
