import ExcelJS from 'exceljs';
import prisma from '../database/prisma.js';

function flattenRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = '';
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

export function toXLSX(sheets) {
  // sheets: [{ name, rows }]
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
    if (sheet.rows.length) {
      const headers = Object.keys(sheet.rows[0]);
      worksheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 4) }));
      for (const row of sheet.rows) worksheet.addRow(row);
      worksheet.getRow(1).font = { bold: true };
    }
  }
  return workbook.xlsx.writeBuffer().then((buf) => Buffer.from(buf));
}

async function teamRows() {
  const teams = await prisma.teams.findMany({ orderBy: { team_name: 'asc' } });
  return teams.map((t) =>
    flattenRow({
      team_id: t.team_id,
      team_name: t.team_name,
      game_type: t.game_type,
      discord_role_id: t.discord_role_id,
      is_active: t.is_active,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }),
  );
}

async function playerRows() {
  const players = await prisma.players.findMany({
    include: { team: true },
    orderBy: { discord_username: 'asc' },
  });
  return players.map((p) =>
    flattenRow({
      id: p.id,
      discord_user_id: p.discord_user_id,
      discord_username: p.discord_username,
      team_id: p.team?.team_id ?? '',
      team_name: p.team?.team_name ?? '',
      game_type: p.team?.game_type ?? '',
      registered_at: p.registered_at,
      updated_at: p.updated_at,
    }),
  );
}

async function matchRows() {
  const matches = await prisma.matches.findMany({
    include: { team1: true, team2: true, results: true },
    orderBy: { created_at: 'desc' },
  });
  return matches.map((m) =>
    flattenRow({
      id: m.id,
      team1_id: m.team1?.team_id ?? '',
      team1_name: m.team1?.team_name ?? '',
      team2_id: m.team2?.team_id ?? '',
      team2_name: m.team2?.team_name ?? '',
      discord_thread_id: m.discord_thread_id,
      status: m.status,
      score1: m.results[0]?.score1 ?? '',
      score2: m.results[0]?.score2 ?? '',
      result_status: m.results[0]?.status ?? '',
      created_at: m.created_at,
      updated_at: m.updated_at,
    }),
  );
}

async function resultRows() {
  const results = await prisma.results.findMany({
    include: { match: { include: { team1: true, team2: true } } },
    orderBy: { submitted_at: 'desc' },
  });
  return results.map((r) =>
    flattenRow({
      id: r.id,
      match_id: r.match_id,
      team1_name: r.match?.team1?.team_name ?? '',
      team2_name: r.match?.team2?.team_name ?? '',
      score1: r.score1,
      score2: r.score2,
      status: r.status,
      submitted_by: r.submitted_by,
      submitted_at: r.submitted_at,
      confirmed_at: r.confirmed_at,
    }),
  );
}

const DATASETS = {
  teams: { name: 'Teams', load: teamRows },
  players: { name: 'Players', load: playerRows },
  matches: { name: 'Matches', load: matchRows },
  results: { name: 'Results', load: resultRows },
};

export async function exportDataset(dataset, format = 'json') {
  const entry = DATASETS[dataset];
  if (!entry) throw new Error(`Unknown dataset: ${dataset}`);
  const rows = await entry.load();
  if (format === 'csv') {
    return { contentType: 'text/csv; charset=utf-8', filename: `${dataset}.csv`, body: toCSV(rows) };
  }
  if (format === 'xlsx') {
    const body = await toXLSX([{ name: entry.name, rows }]);
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${dataset}.xlsx`,
      body,
    };
  }
  return { contentType: 'application/json; charset=utf-8', filename: `${dataset}.json`, body: JSON.stringify(rows, null, 2) };
}

export async function exportAll(format = 'json') {
  const names = Object.keys(DATASETS);
  if (format === 'json') {
    const data = {};
    for (const name of names) data[name] = await DATASETS[name].load();
    data.exported_at = new Date().toISOString();
    return {
      contentType: 'application/json; charset=utf-8',
      filename: 'all_data.json',
      body: JSON.stringify(data, null, 2),
    };
  }
  if (format === 'csv') {
    // ZIP-free approach: single CSV with section markers.
    const sections = [];
    for (const name of names) {
      sections.push(`# ${name.toUpperCase()}`);
      sections.push(toCSV(await DATASETS[name].load()));
      sections.push('');
    }
    return { contentType: 'text/csv; charset=utf-8', filename: 'all_data.csv', body: sections.join('\n') };
  }
  const sheets = [];
  for (const name of names) sheets.push({ name: DATASETS[name].name, rows: await DATASETS[name].load() });
  const body = await toXLSX(sheets);
  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: 'all_data.xlsx',
    body,
  };
}

export default { exportDataset, exportAll, toCSV, toXLSX };
