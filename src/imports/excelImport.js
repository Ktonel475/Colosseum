import ExcelJS from 'exceljs';
import { z } from 'zod';
import { describeCategory, teamNameKey } from '../utils/teamIdentity.js';

const TeamRowSchema = z.object({
  team_id: z.string().trim().min(1, 'team_id is required'),
  team_name: z.string().trim().min(1, 'team_name is required'),
  game_type: z.string().trim().max(100).nullable().optional(),
});

const HEADER_ALIASES = {
  team_id: ['team_id', 'team id', 'teamid', 'id', 'รหัสทีม'],
  team_name: ['team_name', 'team name', 'teamname', 'name', 'ชื่อทีม'],
  game_type: ['game_type', 'game type', 'gametype', 'game', 'ประเภทเกม'],
};

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveHeader(normalized) {
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  return null;
}

function cellToString(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value) return String(value.text).trim();
    if ('result' in value) return String(value.result).trim();
    if ('richText' in value) return value.richText.map((t) => t.text).join('').trim();
  }
  return String(value).trim();
}

/**
 * Parse an XLSX buffer containing team data.
 * @returns {Promise<{ rows: Array<{team_id:string, team_name:string, game_type:string|null}>, errors: string[] }>}
 */
export async function parseTeamWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { rows: [], errors: ['File is not a readable XLSX document.'] };
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { rows: [], errors: ['Workbook contains no worksheets.'] };
  }

  const headerRow = worksheet.getRow(1);
  const columnMap = {};
  headerRow.eachCell((cell, colNumber) => {
    const field = resolveHeader(normalizeHeader(cellToString(cell)));
    if (field) columnMap[field] = colNumber;
  });

  const missing = [];
  if (!columnMap.team_id) missing.push('team_id');
  if (!columnMap.team_name) missing.push('team_name');
  if (missing.length) {
    return { rows: [], errors: [`Missing required column(s): ${missing.join(', ')}`] };
  }

  const rows = [];
  const errors = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const team_id = cellToString(row.getCell(columnMap.team_id));
    const team_name = cellToString(row.getCell(columnMap.team_name));
    const rawGameType = columnMap.game_type
      ? cellToString(row.getCell(columnMap.game_type))
      : '';
    const game_type = rawGameType.length ? rawGameType : null;
    if (!team_id && !team_name) return;

    const result = TeamRowSchema.safeParse({ team_id, team_name, game_type });
    if (!result.success) {
      errors.push(`Row ${rowNumber}: ${result.error.issues[0].message}`);
      return;
    }
    rows.push(result.data);
  });

  return { rows, errors };
}

/**
 * Validate a parsed team list. Only `team_id` (รหัสทีม) must be unique.
 * A team name may be reused in a different competition category
 * (game type), so name duplicates are only rejected inside the same category.
 * @returns {string[]} errors
 */
export function validateTeamRows(rows) {
  const errors = [];
  const seenIds = new Map();
  const seenNames = new Map();

  rows.forEach((row, index) => {
    const idKey = row.team_id.toLowerCase();
    const nameKey = teamNameKey(row.team_name, row.game_type);

    if (seenIds.has(idKey)) {
      errors.push(
        `Duplicate team_id '${row.team_id}' (rows ${seenIds.get(idKey)} and ${index + 2})`,
      );
    } else {
      seenIds.set(idKey, index + 2);
    }

    if (seenNames.has(nameKey)) {
      errors.push(
        `Duplicate team_name '${row.team_name}' in ${describeCategory(row.game_type)} ` +
          `(rows ${seenNames.get(nameKey)} and ${index + 2}). ` +
          'The same name is allowed in a different game type.',
      );
    } else {
      seenNames.set(nameKey, index + 2);
    }
  });

  return errors;
}

export default { parseTeamWorkbook, validateTeamRows };
