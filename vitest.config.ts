import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

/**
 * Tests run inside workerd, against a real D1 binding — the same runtime and the
 * same SQLite the deployed Worker uses. That matters here more than usual: the
 * no-negative-stock rule is enforced by a guarded INSERT, so a mock database
 * would test the mock rather than the constraint.
 *
 * The schema comes from the same migrations that are applied in production; each
 * test file gets isolated storage.
 */
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        // The pool bundles its own workerd, which trails the deployed runtime by
        // a few days. Pinned here rather than lowering the production
        // compatibility_date to suit the test tool.
        compatibilityDate: '2026-08-22',
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
