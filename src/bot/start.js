import logger from '../utils/logger.js';
import prisma from '../database/prisma.js';
import { startBot } from './index.js';

async function main() {
  const client = await startBot();
  if (!client) {
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await client.destroy();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal bot startup error');
  process.exit(1);
});
