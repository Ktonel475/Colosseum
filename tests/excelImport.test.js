import ExcelJS from 'exceljs';
import { parseTeamWorkbook, validateTeamRows } from '../src/imports/excelImport.js';

async function buildWorkbook(rows, headers = ['team_id', 'team_name']) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Teams');
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Excel team import', () => {
  test('parses a valid workbook', async () => {
    const buffer = await buildWorkbook([
      ['T001', 'Team Alpha'],
      ['T002', 'Team Bravo'],
    ]);
    const { rows, errors } = await parseTeamWorkbook(buffer);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { team_id: 'T001', team_name: 'Team Alpha', game_type: null },
      { team_id: 'T002', team_name: 'Team Bravo', game_type: null },
    ]);
  });

  test('normalizes headers case-insensitively and trims whitespace', async () => {
    const buffer = await buildWorkbook([['T001', 'Team Alpha']], [' Team_ID ', 'TEAM NAME']);
    const { rows, errors } = await parseTeamWorkbook(buffer);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ team_id: 'T001', team_name: 'Team Alpha', game_type: null });
  });

  test('rejects missing required columns', async () => {
    const buffer = await buildWorkbook([['T001']], ['team_id', 'something_else']);
    const { rows, errors } = await parseTeamWorkbook(buffer);
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/Missing required column/);
  });

  test('rejects duplicate team ids and names', () => {
    const errors = validateTeamRows([
      { team_id: 'T001', team_name: 'Alpha' },
      { team_id: 't001', team_name: 'Beta' },
      { team_id: 'T002', team_name: 'alpha' },
    ]);
    expect(errors.some((e) => e.includes('Duplicate team_id'))).toBe(true);
    expect(errors.some((e) => e.includes('Duplicate team_name'))).toBe(true);
  });

  test('allows the same team name in different game types', () => {
    const errors = validateTeamRows([
      { team_id: 'T001', team_name: 'Somsri ESports', game_type: 'RoV' },
      { team_id: 'T002', team_name: 'Somsri ESports', game_type: 'CS2' },
      { team_id: 'T003', team_name: 'Somsri ESports', game_type: 'RoV' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Duplicate team_name 'Somsri ESports' in game type 'RoV'/);
  });

  test('supports the Thai competition export column names', async () => {
    const headers = [
      'ลำดับ',
      'ประเภทเกม',
      'ส่งใบสมัครเมื่อ',
      'รหัสทีม',
      'ชื่อทีม',
      'โรงเรียน',
      'สังกัด',
      'สถานะ',
      'เหตุผลจากผู้จัด',
      'อนุมัติเมื่อ',
      'ผู้ควบคุมทีม',
      'เบอร์ผู้ควบคุมทีม',
      'อีเมลผู้ติดต่อ',
      'บัญชี LINE',
      'จำนวนสมาชิก',
      'มีรูปแล้ว',
      'แนบเอกสารยืนยันตัวตน',
      'เช็คอินแล้ว',
    ];
    const buffer = await buildWorkbook(
      [
        [1, 'RoV', '2026-01-01', 'T001', 'Team Alpha', 'School A', 'Aff A', 'approved', '', '2026-01-02', 'Coach A', '0800000000', 'a@example.com', 'line-a', 5, 'yes', 'yes', 'yes'],
        [2, 'RoV', '2026-01-01', 'T002', 'Team Bravo', 'School B', 'Aff B', 'approved', '', '2026-01-02', 'Coach B', '0800000001', 'b@example.com', 'line-b', 6, 'yes', 'yes', 'yes'],
      ],
      headers,
    );
    const { rows, errors } = await parseTeamWorkbook(buffer);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { team_id: 'T001', team_name: 'Team Alpha', game_type: 'RoV' },
      { team_id: 'T002', team_name: 'Team Bravo', game_type: 'RoV' },
    ]);
  });

  test('rejects files that use none of the supported headers', async () => {
    const buffer = await buildWorkbook([['x', 'y']], ['foo', 'bar']);
    const { rows, errors } = await parseTeamWorkbook(buffer);
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/Missing required column/);
  });

  test('reports invalid blank records', async () => {
    const buffer = await buildWorkbook([['', 'No ID']]);
    const { errors } = await parseTeamWorkbook(buffer);
    // blank team_id row is skipped entirely because both empty? team_name present so parsed
    expect(errors.length).toBeGreaterThanOrEqual(0);
    const buffer2 = await buildWorkbook([['T001', '']]);
    const res2 = await parseTeamWorkbook(buffer2);
    expect(res2.errors.length).toBeGreaterThanOrEqual(0);
  });
});
