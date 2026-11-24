import config from '../config/index.js';
import logger from '../utils/logger.js';
import prisma from '../database/prisma.js';
import { buildApp } from './app.js';
import { startBot } from '../bot/index.js';

async function main() {
  const app = buildApp();
  let server;
  let client;

  if (config.enableApi) {
    server = app.listen(config.api.port, () => {
      logger.info({ port: config.api.port }, 'REST API listening');
    });
  }

  if (config.enableBot) {
    try {
      client = await startBot();
    } catch (err) {
      logger.error({ err }, 'Failed to start Discord bot');
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      if (client) await client.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
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
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
