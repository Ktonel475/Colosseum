import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export default async function globalSetup() {
  mkdirSync('data', { recursive: true });
  execSync('npx prisma db push --skip-generate --force-reset --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: 'file:../data/test.db' },
  });
}
