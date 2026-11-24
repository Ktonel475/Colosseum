import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config/index.js';

const transports = [];

if (config.log.file) {
  try {
    mkdirSync(dirname(config.log.file), { recursive: true });
    transports.push({
      target: 'pino/file',
      options: { destination: config.log.file, mkdir: true },
    });
  } catch {
    // fall back to stdout only
  }
}

transports.push({
  target: 'pino/file',
  options: { destination: 1 },
});

export const logger = pino({
  level: config.log.level,
  transport: { targets: transports },
});

export default logger;
