import prisma from '../src/database/prisma.js';
import { buildApp } from '../src/api/app.js';
import { resetDb, seedTeams } from './helpers.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(resetDb);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

const auth = { Authorization: 'Bearer test-secret' };

describe('REST API', () => {
  test('health endpoint responds', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('lists teams with pagination metadata', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/teams`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toMatchObject({ page: 1, limit: 25, total: 2 });
  });

  test('paginates team results', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/teams?page=2&limit=1`);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.pages).toBe(2);
  });

  test('filters teams by search term', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/teams?search=Bravo`);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].team_name).toBe('Team Bravo');
  });

  test('returns 404 for unknown team', async () => {
    const res = await fetch(`${baseUrl}/api/teams/nope`);
    expect(res.status).toBe(404);
  });

  test('export requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/export/teams`);
    expect(res.status).toBe(401);
  });

  test('rejects an invalid bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/export/teams`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  test('exports JSON with a valid token', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/export/teams`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  test('exports CSV', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/export/teams?format=csv`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('team_id');
    expect(text).toContain('Team Alpha');
  });

  test('exports XLSX', async () => {
    await seedTeams();
    const res = await fetch(`${baseUrl}/api/export/all?format=xlsx`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(100);
    // XLSX files are ZIP archives: "PK" magic bytes
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });
});
