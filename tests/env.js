process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:../data/test.db';
process.env.API_AUTH_SECRET = process.env.API_AUTH_SECRET || 'test-secret';
process.env.RESULT_CONFIRMATION_POLICY = process.env.RESULT_CONFIRMATION_POLICY || 'both_teams';
process.env.ADMINISTRATOR_ROLE_ID = 'role-admin';
process.env.LOG_LEVEL = 'silent';
process.env.ENABLE_BOT = 'false';
process.env.ENABLE_API = 'false';