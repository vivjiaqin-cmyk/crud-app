import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Provided by vitest.config.ts so setup.ts can create the schema. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
