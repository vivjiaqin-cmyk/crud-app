import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per test file, before its tests, against that file's isolated
// storage. The migrations are the production ones, read in vitest.config.ts.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
