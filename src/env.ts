/**
 * The Worker's bindings and the settings derived from them.
 *
 * On Workers there is no process-wide environment: `env` arrives with each
 * request, so configuration is a function of it rather than a module constant.
 */

export interface Bindings {
  DB: D1Database;
  /** Static assets (the UI). Bound automatically by the assets config. */
  ASSETS?: Fetcher;
  ALLOW_NEGATIVE_STOCK?: string;
  CORS_ORIGINS?: string;
}

/** Hono's generic parameter, so handlers get typed access to c.env. */
export interface AppEnv {
  Bindings: Bindings;
}

export interface Settings {
  /**
   * Off by default: an issue that would drive on-hand below zero is a data entry
   * mistake far more often than it is a real backorder. Turn it on if your
   * process genuinely books issues before receipts land.
   */
  allowNegativeStock: boolean;
  /**
   * Origins allowed to call this API from a browser. Empty is the default and
   * means same-origin only — no Access-Control-Allow-Origin is sent at all.
   * ["*"] allows any origin.
   */
  corsOrigins: string[];
}

export function settings(env: Bindings): Settings {
  return {
    allowNegativeStock: env.ALLOW_NEGATIVE_STOCK === 'true' || env.ALLOW_NEGATIVE_STOCK === '1',
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  };
}
