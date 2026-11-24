import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.string().default('development'),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  MATCH_MANAGEMENT_CHANNEL_ID: z.string().optional(),
  ADMINISTRATOR_ROLE_ID: z.string().optional(),
  COMPETITION_STAFF_ROLE_ID: z.string().optional(),
  MATCH_MODULE_ONLY: booleanish,

  API_PORT: z.coerce.number().int().positive().default(3000),
  API_AUTH_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),

  DATABASE_URL: z.string().default('file:../data/dev.db'),

  RESULT_CONFIRMATION_POLICY: z
    .enum(['both_teams', 'administrator', 'automatic'])
    .default('both_teams'),
  INTERACTION_EXPIRATION: z.coerce.number().int().positive().default(300000),

  MAX_FILE_SIZE: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SUPPORT_CHANNEL_ID: z.string().optional(),

  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().optional(),

  ENABLE_BOT: booleanish,
  ENABLE_API: booleanish,
  ENABLE_DEV_COMMANDS: booleanish,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  env: parsed.data.NODE_ENV,
  discord: {
    token: parsed.data.DISCORD_BOT_TOKEN,
    clientId: parsed.data.DISCORD_CLIENT_ID,
    matchChannelId: parsed.data.MATCH_MANAGEMENT_CHANNEL_ID,
    adminRoleId: parsed.data.ADMINISTRATOR_ROLE_ID,
    staffRoleId: parsed.data.COMPETITION_STAFF_ROLE_ID,
    supportChannelId: parsed.data.SUPPORT_CHANNEL_ID,
  },
  api: {
    port: parsed.data.API_PORT,
    authSecret: parsed.data.API_AUTH_SECRET,
    corsOrigin: parsed.data.CORS_ORIGIN,
    rateLimitWindowMs: parsed.data.API_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: parsed.data.API_RATE_LIMIT_MAX,
  },
  databaseUrl: parsed.data.DATABASE_URL,
  match: {
    moduleOnly: parsed.data.MATCH_MODULE_ONLY ?? false,
  },
  resultConfirmationPolicy: parsed.data.RESULT_CONFIRMATION_POLICY,
  interactionExpiration: parsed.data.INTERACTION_EXPIRATION,
  maxFileSize: parsed.data.MAX_FILE_SIZE,
  log: {
    level: parsed.data.LOG_LEVEL,
    file: parsed.data.LOG_FILE,
  },
  enableBot: parsed.data.ENABLE_BOT ?? parsed.data.NODE_ENV !== 'test',
  enableApi: parsed.data.ENABLE_API ?? parsed.data.NODE_ENV !== 'test',
  devCommands: parsed.data.ENABLE_DEV_COMMANDS ?? parsed.data.NODE_ENV !== 'production',
};

export default config;
