import { Hono } from 'hono';
import { ABSENT, enumField, jsonBody, optionalString, rejectUnknown, requiredString } from '../body';
import {
  LOCATION_KINDS,
  countMovementsForLocation,
  createLocation,
  deleteLocation,
  findLocationByCode,
  listLocations,
  requireLocation,
  updateLocation,
  type LocationPatch,
} from '../data/locations';
import { listStock } from '../data/stock';
import { guard } from '../db/constraints';
import type { AppEnv } from '../env';
import { HttpError } from '../errors';
import { boolParam, enumParam, idParam } from '../query';

export const locations = new Hono<AppEnv>();

const FIELDS = ['code', 'name', 'kind'] as const;
const CODE_TAKEN = { code: 'A location with that code already exists' };

/** GET /locations?kind=warehouse|store|transit */
locations.get('/locations', async (c) => {
  const kind = enumParam(c.req.query('kind'), 'kind', LOCATION_KINDS);
  const rows = await listLocations(c.env.DB, kind);
  return c.json({ count: rows.length, locations: rows });
});

/** GET /locations/:id — the location and everything currently in it. */
locations.get('/locations/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const location = await requireLocation(c.env.DB, id);
  const stock = await listStock(c.env.DB, { locationId: id, includeZero: false });
  return c.json({ ...location, stock });
});

/** POST /locations */
locations.post('/locations', async (c) => {
  const body = await jsonBody(c.req);
  rejectUnknown(body, FIELDS);

  const code = requiredString(body, 'code', 32);
  if ((await findLocationByCode(c.env.DB, code)) !== undefined) {
    throw new HttpError(409, `A location with code "${code}" already exists`);
  }

  const kind = enumField(body, 'kind', LOCATION_KINDS);
  const location = await guard(CODE_TAKEN, () =>
    createLocation(c.env.DB, {
      code,
      name: requiredString(body, 'name'),
      kind: kind === ABSENT ? 'warehouse' : kind,
    }),
  );

  c.header('Location', `/locations/${location.id}`);
  return c.json(location, 201);
});

/** PATCH /locations/:id */
locations.patch('/locations/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const body = await jsonBody(c.req);
  rejectUnknown(body, FIELDS);

  const patch: LocationPatch = {};

  const code = optionalString(body, 'code', 32);
  if (code !== ABSENT) {
    const clash = await findLocationByCode(c.env.DB, code);
    if (clash !== undefined && clash.id !== id) {
      throw new HttpError(409, `A location with code "${code}" already exists`);
    }
    patch.code = code;
  }

  const name = optionalString(body, 'name');
  if (name !== ABSENT) patch.name = name;

  const kind = enumField(body, 'kind', LOCATION_KINDS);
  if (kind !== ABSENT) patch.kind = kind;

  return c.json(await guard(CODE_TAKEN, () => updateLocation(c.env.DB, id, patch)));
});

/**
 * DELETE /locations/:id
 *
 * Refuses while stock or history is attached. Locations have no archive flag —
 * an empty location is cheap to keep and a deleted one takes its movements with
 * it, so ?force=true is the only way through and it says what it will destroy.
 */
locations.delete('/locations/:id', async (c) => {
  const id = idParam(c.req.param('id'), 'id');
  const force = boolParam(c.req.query('force'), 'force');
  const location = await requireLocation(c.env.DB, id);
  const history = await countMovementsForLocation(c.env.DB, id);

  if (history > 0 && !force) {
    throw new HttpError(
      409,
      `Location ${location.code} has ${history} movement${history === 1 ? '' : 's'} ` +
        `and ${location.unitsOnHand} unit${location.unitsOnHand === 1 ? '' : 's'} on hand. ` +
        'Transfer the stock out first, or repeat with ?force=true to delete the history too.',
    );
  }

  const movementsDeleted = await deleteLocation(c.env.DB, id);
  return c.json({ deleted: { id, code: location.code }, movementsDeleted });
});
