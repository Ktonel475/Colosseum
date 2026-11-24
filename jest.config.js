export default {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  setupFiles: ['<rootDir>/tests/env.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  maxWorkers: 1,
  transform: {},
  verbose: true,
};
