import { PrismaClient } from '@prisma/client';
import config from '../config/index.js';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__competitionPrisma ||
  new PrismaClient({
    log: config.env === 'development' ? ['warn', 'error'] : ['error'],
  });

if (config.env !== 'production') {
  globalForPrisma.__competitionPrisma = prisma;
}

export default prisma;
